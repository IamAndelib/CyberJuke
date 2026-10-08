import type { Page, Route } from '@playwright/test';
import { AUTH_USER, buildDataset, type Dataset } from './data';
import { isPublicQuery, runQuery, type StructuredQuery } from './firestore';

/**
 * The Cyberspace backend, faked: Firestore runQuery over the synthetic dataset, the
 * users/{uid} doc, and the Firebase Auth login (identitytoolkit sign-in, securetoken
 * refresh). Nothing reaches the network.
 *
 * Sign-in errors by input: password "wrong" → INVALID_LOGIN_CREDENTIALS, email
 * starting "busy" → TOO_MANY_ATTEMPTS_TRY_LATER, email starting "offline" → the
 * request fails. `rejectFirstToken`: the first ID token gets one 401 from Firestore.
 */
export interface BackendOptions {
  rejectFirstToken?: boolean;
  /** Extra latency for runQuery, ms. */
  delay?: number;
}

export interface Backend {
  data: Dataset;
  calls: { signIn: number; refresh: number; userDoc: number; members: number; unauthorized: number; public: number };
  /** Authorization headers of signed-in queries, in order. */
  tokens: string[];
  /** structuredQuery of every signed-in query. */
  memberBodies: StructuredQuery[];
  /** structuredQuery of every query. */
  queries: StructuredQuery[];
  /** Make runQuery fail (as if offline) until set back to false. */
  offline: boolean;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

let shared: Dataset | null = null;
/** One dataset per worker (it only depends on the hour). */
export function dataset(): Dataset {
  return (shared ??= buildDataset());
}

export async function stubBackend(page: Page, opts: BackendOptions = {}): Promise<Backend> {
  const data = dataset();
  const b: Backend = {
    data,
    calls: { signIn: 0, refresh: 0, userDoc: 0, members: 0, unauthorized: 0, public: 0 },
    tokens: [],
    memberBodies: [],
    queries: [],
    offline: false,
  };
  let issued = 0;
  const valid = new Set<string>();
  let rejected = false;
  const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  const preflight = (route: Route) => route.request().method() === 'OPTIONS' && (route.fulfill({ status: 204, headers: CORS }), true);

  await page.route(/^https:\/\/identitytoolkit\.googleapis\.com\//, async (route) => {
    if (preflight(route)) return;
    b.calls.signIn++;
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (String(body.email).startsWith('offline')) return route.abort('internetdisconnected');
    if (String(body.email).startsWith('busy'))
      return route.fulfill(json(400, { error: { code: 400, message: 'TOO_MANY_ATTEMPTS_TRY_LATER : Access to this account has been temporarily disabled' } }));
    if (body.email !== AUTH_USER.email || body.password !== AUTH_USER.password)
      return route.fulfill(json(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } }));
    const idToken = `fake-id-${++issued}`;
    valid.add(idToken);
    return route.fulfill(json(200, { idToken, refreshToken: 'fake-refresh', expiresIn: '3600', localId: AUTH_USER.uid, email: AUTH_USER.email, registered: true }));
  });

  await page.route(/^https:\/\/securetoken\.googleapis\.com\//, async (route) => {
    if (preflight(route)) return;
    b.calls.refresh++;
    const form = new URLSearchParams(route.request().postData() ?? '');
    if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'fake-refresh')
      return route.fulfill(json(400, { error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } }));
    const idToken = `fake-id-${++issued}`;
    valid.add(idToken);
    return route.fulfill(json(200, { id_token: idToken, refresh_token: 'fake-refresh', expires_in: '3600', user_id: AUTH_USER.uid }));
  });

  await page.route(/^https:\/\/firestore\.googleapis\.com\/v1\/projects\/[^/]+\/databases\/\(default\)\/documents\/users\//, async (route) => {
    if (preflight(route)) return;
    b.calls.userDoc++;
    return route.fulfill(json(200, { name: 'users/' + AUTH_USER.uid, fields: { username: { stringValue: AUTH_USER.username } } }));
  });

  await page.route(/^https:\/\/firestore\.googleapis\.com\/.*:runQuery/, async (route) => {
    if (preflight(route)) return;
    const req = route.request();
    if (b.offline) return route.abort('internetdisconnected');
    const q = (JSON.parse(req.postData() ?? '{}') as { structuredQuery: StructuredQuery }).structuredQuery;
    b.queries.push(q);
    const auth = (await req.allHeaders())['authorization'];
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    if (auth) {
      b.calls.members++;
      b.tokens.push(auth);
      const token = auth.replace(/^Bearer /, '');
      const unauth = [{ error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } }];
      if (!valid.has(token)) return route.fulfill(json(401, unauth));
      if (opts.rejectFirstToken && token === 'fake-id-1' && !rejected) {
        rejected = true;
        b.calls.unauthorized++;
        return route.fulfill(json(401, unauth));
      }
      b.memberBodies.push(q);
    } else {
      b.calls.public++;
      // The members query needs a login, as on the real server.
      if (!isPublicQuery(q)) return route.fulfill(json(403, [{ error: { code: 403, message: 'Missing or insufficient permissions.', status: 'PERMISSION_DENIED' } }]));
    }
    return route.fulfill(json(200, runQuery(data.docs, q)));
  });
  return b;
}
