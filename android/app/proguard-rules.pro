# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ---------------------------------------------------------------------------------------
# CyberJuke release rules (R8). Correctness over size: keep anything reached by reflection.
# ---------------------------------------------------------------------------------------

# Keep readable stack traces in crash reports / CI logs.
-keepattributes SourceFile,LineNumberTable,*Annotation*,Signature,InnerClasses,EnclosingMethod
-dontobfuscate

# ---- Logging (S5): release builds drop verbose/debug/info logs, including the strings built
# for them. Anything with search queries, video or track ids is logged at info level only;
# warnings and errors carry exception class names and status codes, never user data.
-assumenosideeffects class android.util.Log {
    public static int v(...);
    public static int d(...);
    public static int i(...);
    public static boolean isLoggable(java.lang.String, int);
}

# ---- Capacitor: plugins and their @PluginMethod methods are found by reflection ----
# The bridge core is kept whole: it is reached from the WebView (JavascriptInterface) and by
# reflection in ways its consumer rules do not fully describe, and it is small.
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.PluginMethod public <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    public <init>(...);
}
-keep public class * extends com.getcapacitor.Plugin { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ---- Our own code: no blanket keep. The plugins are kept by the Capacitor rules above, the
# activity and PlaybackService by the manifest (AAPT rules); nothing else uses reflection.

# ---- NewPipeExtractor (the rules the NewPipe app ships) ----
# timeago patterns are loaded by class name per language; protobuf-lite messages reflect on
# their fields. The rest of the extractor is plain code R8 can shrink.
-keep class org.schabi.newpipe.extractor.timeago.patterns.** { *; }
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageLite {
    <fields>;
}

# Rhino + Rhino engine (JS signature/throttling deobfuscation; heavy reflection)
-keep class org.mozilla.javascript.* { *; }
-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.javascript.engine.** { *; }
-keep class org.mozilla.classfile.ClassFileWriter
-keep class javax.script.** { *; }
-keep class jdk.dynalink.** { *; }
# Optional desktop-JVM integrations Rhino references but never loads on Android
# (javax.script/dynalink are JDK modules, java.beans is absent on Android; the tools
# package is Rhino's shell). Same list as the NewPipe app.
-dontwarn org.mozilla.javascript.JavaToJSONConverters
-dontwarn org.mozilla.javascript.tools.**
-dontwarn javax.script.**
-dontwarn jdk.dynalink.**
-dontwarn java.beans.**

# jsoup and OkHttp ship their own consumer rules (jsoup's optional re2j engine, OkHttp's
# optional TLS providers), so no blanket -dontwarn for them.
# jsr305 annotations (javax.annotation.Nonnull etc.) are compile-only in NewPipeExtractor:
# annotation types only, nothing is loaded at runtime.
-dontwarn javax.annotation.**

-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    !static !transient <fields>;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
}

# ---- OkHttp / Okio: optional TLS providers OkHttp probes for and never finds on Android.
# OkHttp 4.12's consumer rules list these too; kept explicitly as they are optional by design.
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# ---- Media3: ships its own consumer rules (including the reflective HLS factory), so no
# blanket -dontwarn: a missing Media3 class should fail the release build.
-keep class androidx.media3.exoplayer.hls.HlsMediaSource$Factory { <init>(...); }
