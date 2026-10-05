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

# ---- Capacitor: plugins and their @PluginMethod methods are found by reflection ----
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

# ---- Our player package (service is referenced from the manifest, plugin by reflection) ----
-keep class io.github.iamandelib.cyberjuke.** { *; }

# ---- NewPipeExtractor (same rules NewPipe ships) ----
-keep class org.schabi.newpipe.extractor.** { *; }
-keep class org.schabi.newpipe.extractor.timeago.patterns.** { *; }
-dontwarn org.schabi.newpipe.extractor.**

# Rhino + Rhino engine (JS signature/throttling deobfuscation)
-keep class org.mozilla.javascript.* { *; }
-keep class org.mozilla.javascript.** { *; }
-keep class org.mozilla.javascript.engine.** { *; }
-keep class org.mozilla.classfile.ClassFileWriter
-dontwarn org.mozilla.javascript.JavaToJSONConverters
-dontwarn org.mozilla.javascript.tools.**
-keep class javax.script.** { *; }
-dontwarn javax.script.**
-keep class jdk.dynalink.** { *; }
-dontwarn jdk.dynalink.**
-dontwarn java.beans.**

# jsoup / nanojson / jsr305 / protobuf-lite
-keep class org.jsoup.** { *; }
-dontwarn org.jsoup.**
-keep class com.grack.nanojson.** { *; }
-dontwarn javax.annotation.**
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageLite {
    <fields>;
}
-dontwarn com.google.protobuf.**

-keepclassmembers class * implements java.io.Serializable {
    static final long serialVersionUID;
    !static !transient <fields>;
    private void writeObject(java.io.ObjectOutputStream);
    private void readObject(java.io.ObjectInputStream);
}

# ---- OkHttp / Okio ----
-dontwarn okhttp3.**
-dontwarn okio.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# ---- Media3: ships consumer rules; keep the reflective extension/source factories anyway ----
-keep class androidx.media3.exoplayer.hls.HlsMediaSource$Factory { <init>(...); }
-dontwarn androidx.media3.**
