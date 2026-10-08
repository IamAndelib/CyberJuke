/**
 * A fake Firestore `runQuery` over the synthetic dataset (./data), with the parts of
 * the real semantics the app relies on: EQUAL and createdAt GREATER_THAN filters (a
 * missing field never matches), createdAt/__name__ descending order, `startAt` with
 * before:false (startAfter), `limit` and the field mask. A query without the
 * isPublic filter (the members query) needs a valid ID token, as on the real server.
 */
import type { Doc, FsValue } from './data';

interface FieldFilter {
  fieldFilter: { field: { fieldPath: string }; op: string; value: FsValue };
}
export interface StructuredQuery {
  select?: { fields: { fieldPath: string }[] };
  from: { collectionId: string }[];
  where?: { compositeFilter: { op: 'AND'; filters: FieldFilter[] } } | FieldFilter;
  orderBy?: { field: { fieldPath: string }; direction: string }[];
  startAt?: { values: FsValue[]; before?: boolean };
  limit?: number;
}

function same(a: FsValue | undefined, b: FsValue): boolean {
  if (!a) return false;
  const [k] = Object.keys(b);
  return k in a && JSON.stringify(a[k]) === JSON.stringify(b[k]);
}

function filters(q: StructuredQuery): FieldFilter[] {
  if (!q.where) return [];
  return 'compositeFilter' in q.where ? q.where.compositeFilter.filters : [q.where];
}

function matches(d: Doc, f: FieldFilter): boolean {
  const { field, op, value } = f.fieldFilter;
  const v = d.fields[field.fieldPath];
  if (op === 'EQUAL') return same(v, value);
  if (op === 'GREATER_THAN' && field.fieldPath === 'createdAt') return d.createdAt > String((value as { timestampValue: string }).timestampValue);
  throw new Error(`fake Firestore: unsupported filter ${op} on ${field.fieldPath}`);
}

/** Newest first; ties by document name, descending. */
function compare(a: Doc, b: Doc): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

/** Whether a query is the public one (has isPublic == true). */
export function isPublicQuery(q: StructuredQuery): boolean {
  return filters(q).some((f) => f.fieldFilter.field.fieldPath === 'isPublic' && same({ booleanValue: true }, f.fieldFilter.value) === true);
}

export function runQuery(docs: Doc[], q: StructuredQuery, readTime = new Date().toISOString()): unknown[] {
  let rows = docs.filter((d) => filters(q).every((f) => matches(d, f))).sort(compare);
  if (q.startAt) {
    const [tsv, ref] = q.startAt.values as [{ timestampValue: string }, { referenceValue: string }];
    const after = (d: Doc) => d.createdAt < tsv.timestampValue || (d.createdAt === tsv.timestampValue && d.name < ref.referenceValue);
    rows = rows.filter(after);
  }
  rows = rows.slice(0, q.limit ?? rows.length);
  const mask = q.select?.fields.map((f) => f.fieldPath);
  if (!rows.length) return [{ readTime }];
  return rows.map((d) => ({
    document: {
      name: d.name,
      fields: mask ? Object.fromEntries(mask.filter((k) => k in d.fields).map((k) => [k, d.fields[k]])) : d.fields,
      createTime: d.createdAt,
      updateTime: d.createdAt,
    },
    readTime,
  }));
}
