package com.mochi.remote;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ClipData;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.media.MediaDescription;
import android.media.MediaMetadata;
import android.media.MediaRecorder;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import androidx.core.content.FileProvider;
import java.lang.ref.WeakReference;
import java.net.URLDecoder;
import java.util.List;
import java.util.UUID;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends Activity {
    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final int FILE_PICK_REQUEST = 57;
    private static final int WEB_PERMISSION_REQUEST = 59;
    private static final int FILE_MEDIA_PERMISSION_REQUEST = 60;
    private static final int NATIVE_VOICE_PERMISSION_REQUEST = 61;
    private static final int CHAT_NOTIFY_PERMISSION_REQUEST = 62;
    private static final String CHAT_NOTIFY_CHANNEL = "cici_chat_messages";
    private static final String CHAT_NOTIFY_TAG_EXTRA = "cici_chat_notification_tag";
    private static final AtomicInteger chatNotificationIds = new AtomicInteger(2000);
    private static final String NETEASE_PACKAGE = "com.netease.cloudmusic";
    private static WeakReference<MainActivity> visible = new WeakReference<>(null);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService musicExecutor = Executors.newFixedThreadPool(3);
    private final ExecutorService fileExecutor = Executors.newSingleThreadExecutor();
    private ComponentName listener;
    private WebView web;
    private MediaSessionManager sessions;
    private MediaController controller;
    private ValueCallback<Uri[]> fileCallback;
    private WebChromeClient.FileChooserParams pendingFileParams;
    private PermissionRequest pendingWebPermission;
    private MediaRecorder nativeVoiceRecorder;
    private File nativeVoiceFile;
    private String nativeVoiceToken;
    private String nativeVoiceFinishingToken;
    private String pendingNativeVoiceToken;
    private File cameraTemp;
    private Uri cameraUri;
    private File exportTemp;
    private String exportToken;
    private String exportName;
    private String exportMime;
    private boolean resumed;
    private boolean nativeChatEnabled;
    private boolean webPageReady;
    private String pendingChatNotificationTag;
    private volatile boolean destroyed;
    private final MediaController.Callback mediaCallback = new MediaController.Callback() {
        @Override public void onMetadataChanged(MediaMetadata metadata) { refreshState(); }
        @Override public void onPlaybackStateChanged(PlaybackState state) { refreshState(); }
        @Override public void onQueueChanged(List<MediaSession.QueueItem> queue) { refreshState(); }
        @Override public void onQueueTitleChanged(CharSequence title) { refreshState(); }
        @Override public void onSessionDestroyed() { refreshState(); }
    };
    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsChanged = controllers -> refreshState();
    private final Runnable progressTick = new Runnable() {
        @Override public void run() {
            if (resumed) { sendState(false); main.postDelayed(this, 1000); }
        }
    };

    public static void requestVisibleRefresh() {
        MainActivity activity = visible.get();
        if (activity != null) activity.main.post(activity::refreshState);
    }

    public static void requestBackgroundChatTick() {
        MainActivity activity = visible.get();
        if (activity == null) return;
        activity.main.post(() -> {
            if (!activity.destroyed && !activity.resumed && activity.web != null)
                activity.web.evaluateJavascript("window.ciciBackgroundTick&&window.ciciBackgroundTick()", null);
        });
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        pendingChatNotificationTag = getIntent().getStringExtra(CHAT_NOTIFY_TAG_EXTRA);
        listener = new ComponentName(this, MusicNotificationListener.class);
        sessions = (MediaSessionManager) getSystemService(MEDIA_SESSION_SERVICE);
        fileExecutor.execute(() -> {
            File dir = new File(getCacheDir(), "picked_images");
            File[] old = dir.listFiles();
            if (old != null) for (File item : old)
                if (item.isFile() && System.currentTimeMillis() - item.lastModified() > 24L * 60 * 60 * 1000) item.delete();
        });
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new RemoteBridge(), "MochiNetease");
        web.addJavascriptInterface(new NeteaseDirectApi(this, musicExecutor, (token, output) -> main.post(() -> {
            if (destroyed || web == null) return;
            web.evaluateJavascript("window.ciciNeteaseEnhancedResponse&&window.ciciNeteaseEnhancedResponse("
                    + JSONObject.quote(token) + "," + JSONObject.quote(output) + ")", null);
        })), "CiCiNeteaseEnhanced");
        web.addJavascriptInterface(new FileSaveBridge(), "MochiFileSave");
        web.addJavascriptInterface(new VoiceRecorderBridge(), "MochiVoiceRecorder");
        web.addJavascriptInterface(new PlaybackGuardBridge(), "CiCiPlaybackGuard");
        web.addJavascriptInterface(new ChatNotificationBridge(), "CiCiChatNotify");
        web.addJavascriptInterface(new ChatKeepAliveBridge(), "CiCiChatKeepAlive");
        web.addJavascriptInterface(new OnlineMusicBridge(), "CiCiMusicApi");
        web.addJavascriptInterface(new VideoInfoBridge(), "CiCiVideoInfo");
        web.addJavascriptInterface(new MailAiBridge(), "CiCiMailAi");
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
                webPageReady = false;
            }
            @Override public void onPageFinished(WebView view, String url) {
                webPageReady = true;
                dispatchPendingChatNotification();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_ORIGIN.equals(uri.getScheme() + "://" + uri.getAuthority())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) {}
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!APP_ORIGIN.equals(uri.getScheme() + "://" + uri.getAuthority())) return null;
                String path;
                try { path = URLDecoder.decode(uri.getEncodedPath(), "UTF-8"); }
                catch (Exception e) { return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", null, null); }
                if (!path.startsWith("/assets/") || path.contains("..") || path.contains("\\"))
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", null, null);
                String asset = path.substring("/assets/".length());
                if (asset.isEmpty()) asset = "index.html";
                try {
                    InputStream stream = getAssets().open(asset);
                    String ext = MimeTypeMap.getFileExtensionFromUrl(asset);
                    String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                    if (mime == null) mime = "application/octet-stream";
                    if (asset.endsWith(".js")) mime = "text/javascript";
                    return new WebResourceResponse(mime, mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json") ? "UTF-8" : null, stream);
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not found", null, null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                clearFileChooser();
                fileCallback = callback;
                pendingFileParams = params;
                String[] missing = missingFilePermissions(params);
                if (missing.length > 0) requestPermissions(missing, FILE_MEDIA_PERMISSION_REQUEST);
                else launchFileChooser();
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                main.post(() -> handleWebPermission(request));
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                main.post(() -> { if (pendingWebPermission == request) pendingWebPermission = null; });
            }
        });
        web.loadUrl(APP_ORIGIN + "/assets/index.html");
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == FILE_PICK_REQUEST && fileCallback != null) {
            final ValueCallback<Uri[]> callback = fileCallback;
            final Uri[] selected = selectedFileUris(result, data);
            fileCallback = null;
            pendingFileParams = null;
            cameraTemp = null;
            cameraUri = null;
            if (selected == null || selected.length == 0) callback.onReceiveValue(null);
            else fileExecutor.execute(() -> {
                ArrayList<Uri> readable = new ArrayList<>();
                for (Uri uri : selected) {
                    if (uri == null) continue;
                    try {
                        Uri staged = stagePickedImage(uri);
                        readable.add(staged == null ? uri : staged);
                    } catch (Exception ignored) {
                        // 非图片仍交还 WebView；图片读取失败则给用户明确反馈。
                        if (!isImageUri(uri)) readable.add(uri);
                    }
                }
                main.post(() -> {
                    if (destroyed) return;
                    callback.onReceiveValue(readable.isEmpty() ? null : readable.toArray(new Uri[0]));
                    if (readable.isEmpty()) android.widget.Toast.makeText(this, "图片读取失败，请换一张或从文件管理器选择", android.widget.Toast.LENGTH_LONG).show();
                });
            });
        }
        if (request == 58 && exportToken != null) {
            boolean saved = false;
            if (result == RESULT_OK && data != null && data.getData() != null && exportTemp != null) {
                try (InputStream source = new FileInputStream(exportTemp);
                     OutputStream target = getContentResolver().openOutputStream(data.getData())) {
                    if (target != null) {
                        byte[] buffer = new byte[65536];
                        int n;
                        while ((n = source.read(buffer)) != -1) target.write(buffer, 0, n);
                        saved = true;
                    }
                } catch (Exception ignored) {}
            }
            String token = exportToken;
            clearExport();
            web.evaluateJavascript("window.mochiNativeSaveResolve&&window.mochiNativeSaveResolve(" + JSONObject.quote(token) + "," + saved + ")", null);
        }
    }

    private Uri[] selectedFileUris(int result, Intent data) {
        if (result != RESULT_OK) return null;
        LinkedHashSet<Uri> uris = new LinkedHashSet<>();
        if (data != null) {
            ClipData clips = data.getClipData();
            if (clips != null) for (int i = 0; i < clips.getItemCount(); i++) {
                Uri uri = clips.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
            if (data.getData() != null) uris.add(data.getData());
        }
        if (uris.isEmpty() && cameraUri != null && cameraTemp != null && cameraTemp.length() > 0)
            uris.add(cameraUri);
        return uris.isEmpty() ? null : uris.toArray(new Uri[0]);
    }

    private boolean isImageUri(Uri uri) {
        try {
            String mime = getContentResolver().getType(uri);
            if (mime != null && mime.startsWith("image/")) return true;
        } catch (Exception ignored) {}
        String path = uri.getLastPathSegment();
        return path != null && path.toLowerCase(java.util.Locale.ROOT).matches(".*\\.(jpe?g|png|gif|webp|bmp|heic|heif)$");
    }

    private Uri stagePickedImage(Uri uri) throws Exception {
        if (!isImageUri(uri)) return null;
        if ((getPackageName() + ".fileprovider").equals(uri.getAuthority())) return uri;
        String name = "image";
        try (Cursor cursor = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String candidate = cursor.getString(0);
                if (candidate != null && !candidate.isEmpty()) name = candidate;
            }
        } catch (Exception ignored) {}
        name = name.replaceAll("[^a-zA-Z0-9._-]", "_");
        if (name.length() > 80) name = name.substring(name.length() - 80);
        if (!name.contains(".")) {
            String mime = getContentResolver().getType(uri);
            String ext = mime == null ? null : MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            name += "." + (ext == null ? "jpg" : ext);
        }
        File dir = new File(getCacheDir(), "picked_images");
        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("image cache unavailable");
        File target = new File(dir, UUID.randomUUID().toString() + "_" + name);
        try (InputStream source = getContentResolver().openInputStream(uri);
             OutputStream output = new FileOutputStream(target)) {
            if (source == null) throw new IllegalStateException("image stream unavailable");
            byte[] buffer = new byte[65536];
            int n;
            while ((n = source.read(buffer)) != -1) output.write(buffer, 0, n);
        } catch (Exception error) { target.delete(); throw error; }
        if (target.length() == 0) { target.delete(); throw new IllegalStateException("image empty"); }
        return FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", target);
    }

    private boolean acceptsImage(WebChromeClient.FileChooserParams params) {
        if (params == null) return false;
        String[] types = params.getAcceptTypes();
        if (types == null) return false;
        for (String type : types) if (type != null && (type.contains("image/") || type.equals("*/*"))) return true;
        return false;
    }

    private String[] missingFilePermissions(WebChromeClient.FileChooserParams params) {
        if (Build.VERSION.SDK_INT < 23 || params == null) return new String[0];
        LinkedHashSet<String> missing = new LinkedHashSet<>();
        String[] types = params.getAcceptTypes();
        boolean image = false;
        boolean video = false;
        if (types != null) for (String type : types) {
            if (type == null) continue;
            image |= type.contains("image/");
            video |= type.contains("video/");
        }
        if (Build.VERSION.SDK_INT >= 33) {
            if (image && checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) != PackageManager.PERMISSION_GRANTED)
                missing.add(Manifest.permission.READ_MEDIA_IMAGES);
            if (video && checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) != PackageManager.PERMISSION_GRANTED)
                missing.add(Manifest.permission.READ_MEDIA_VIDEO);
        } else if ((image || video) && checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        if (acceptsImage(params) && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            missing.add(Manifest.permission.CAMERA);
        return missing.toArray(new String[0]);
    }

    private void clearFileChooser() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
        pendingFileParams = null;
        cameraTemp = null;
        cameraUri = null;
    }

    private void launchFileChooser() {
        if (fileCallback == null || pendingFileParams == null) return;
        Intent picker;
        try { picker = pendingFileParams.createIntent(); }
        catch (Exception e) { clearFileChooser(); return; }
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent camera = null;
        if (acceptsImage(pendingFileParams) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            try {
                File dir = new File(getCacheDir(), "camera");
                if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("camera cache unavailable");
                cameraTemp = File.createTempFile("cici-", ".jpg", dir);
                cameraUri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", cameraTemp);
                camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                camera.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                camera.setClipData(ClipData.newRawUri("photo", cameraUri));
                camera.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                if (camera.resolveActivity(getPackageManager()) == null) camera = null;
            } catch (Exception ignored) { camera = null; cameraTemp = null; cameraUri = null; }
        }
        try {
            if (pendingFileParams.isCaptureEnabled() && camera != null) startActivityForResult(camera, FILE_PICK_REQUEST);
            else {
                Intent chooser = Intent.createChooser(picker, "选择文件或拍照");
                if (camera != null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] { camera });
                startActivityForResult(chooser, FILE_PICK_REQUEST);
            }
        } catch (ActivityNotFoundException | SecurityException e) { clearFileChooser(); }
    }

    private void handleWebPermission(PermissionRequest request) {
        if (request == null) return;
        Uri origin = request.getOrigin();
        if (origin == null || !APP_ORIGIN.equals(origin.getScheme() + "://" + origin.getAuthority())) { request.deny(); return; }
        if (pendingWebPermission != null && pendingWebPermission != request) pendingWebPermission.deny();
        pendingWebPermission = request;
        java.util.ArrayList<String> missing = new java.util.ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) ? Manifest.permission.RECORD_AUDIO
                : PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) ? Manifest.permission.CAMERA : null;
            if (permission != null && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED && !missing.contains(permission)) missing.add(permission);
        }
        if (missing.isEmpty()) finishWebPermission();
        else requestPermissions(missing.toArray(new String[0]), WEB_PERMISSION_REQUEST);
    }

    private void finishWebPermission() {
        PermissionRequest request = pendingWebPermission;
        pendingWebPermission = null;
        if (request == null) return;
        java.util.ArrayList<String> granted = new java.util.ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource) && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
        }
        if (granted.isEmpty()) request.deny();
        else request.grant(granted.toArray(new String[0]));
    }

    private final class VoiceRecorderBridge {
        @JavascriptInterface public void start(String token) { main.post(() -> startNativeVoice(token)); }
        @JavascriptInterface public void stop(String token) { main.post(() -> stopNativeVoice(token)); }
        @JavascriptInterface public void cancel(String token) { main.post(() -> cancelNativeVoice(token)); }
    }

    private void nativeVoiceResult(String token, String status, String payload) {
        if (destroyed || web == null || token == null) return;
        web.evaluateJavascript("window.mochiNativeVoiceResult&&window.mochiNativeVoiceResult("
            + JSONObject.quote(token) + "," + JSONObject.quote(status) + "," + JSONObject.quote(payload == null ? "" : payload) + ")", null);
    }

    private void startNativeVoice(String token) {
        if (token == null || token.isEmpty()) return;
        if (!resumed || nativeVoiceRecorder != null || nativeVoiceFinishingToken != null || pendingNativeVoiceToken != null) {
            nativeVoiceResult(token, "error", "busy");
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingNativeVoiceToken = token;
            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, NATIVE_VOICE_PERMISSION_REQUEST);
            return;
        }
        startGrantedNativeVoice(token);
    }

    private void startGrantedNativeVoice(String token) {
        MediaRecorder recorder = null;
        File file = null;
        try {
            file = File.createTempFile("cici-voice-", ".m4a", getCacheDir());
            recorder = new MediaRecorder();
            recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioEncodingBitRate(64000);
            recorder.setOutputFile(file.getAbsolutePath());
            recorder.prepare();
            recorder.start();
            nativeVoiceRecorder = recorder;
            nativeVoiceFile = file;
            nativeVoiceToken = token;
            nativeVoiceResult(token, "started", "");
        } catch (Exception e) {
            if (recorder != null) { try { recorder.release(); } catch (Exception ignored) {} }
            if (file != null) file.delete();
            nativeVoiceResult(token, "error", "start-failed");
        }
    }

    private void stopNativeVoice(String token) {
        if (token == null || token.isEmpty()) return;
        if (token.equals(nativeVoiceFinishingToken)) return;
        if (!token.equals(nativeVoiceToken) || nativeVoiceRecorder == null) {
            nativeVoiceResult(token, "error", "not-recording");
            return;
        }
        MediaRecorder recorder = nativeVoiceRecorder;
        File file = nativeVoiceFile;
        nativeVoiceRecorder = null;
        nativeVoiceFile = null;
        nativeVoiceToken = null;
        nativeVoiceFinishingToken = token;
        boolean stopped = false;
        try { recorder.stop(); stopped = true; } catch (RuntimeException ignored) {}
        try { recorder.release(); } catch (Exception ignored) {}
        if (!stopped || file == null || file.length() < 128) {
            if (file != null) file.delete();
            nativeVoiceFinishingToken = null;
            nativeVoiceResult(token, "error", "too-short");
            return;
        }
        fileExecutor.execute(() -> {
            String audio = null;
            try (InputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                audio = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
            } catch (Exception ignored) {
            } finally { file.delete(); }
            final String result = audio;
            main.post(() -> {
                if (token.equals(nativeVoiceFinishingToken)) nativeVoiceFinishingToken = null;
                nativeVoiceResult(token, result == null ? "error" : "stopped", result == null ? "read-failed" : result);
            });
        });
    }

    private void cancelNativeVoice(String token) {
        if (token == null || token.isEmpty()) return;
        if (token.equals(pendingNativeVoiceToken)) pendingNativeVoiceToken = null;
        if (!token.equals(nativeVoiceToken)) return;
        MediaRecorder recorder = nativeVoiceRecorder;
        File file = nativeVoiceFile;
        nativeVoiceRecorder = null;
        nativeVoiceFile = null;
        nativeVoiceToken = null;
        if (recorder != null) {
            try { recorder.stop(); } catch (RuntimeException ignored) {}
            try { recorder.release(); } catch (Exception ignored) {}
        }
        if (file != null) file.delete();
    }

    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == FILE_MEDIA_PERMISSION_REQUEST) launchFileChooser();
        if (requestCode == WEB_PERMISSION_REQUEST) finishWebPermission();
        if (requestCode == NATIVE_VOICE_PERMISSION_REQUEST) {
            String token = pendingNativeVoiceToken;
            pendingNativeVoiceToken = null;
            if (token != null) {
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) startGrantedNativeVoice(token);
                else nativeVoiceResult(token, "error", "permission-denied");
            }
        }
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        visible = new WeakReference<>(this);
        dispatchPendingChatNotification();
        if (nativeChatEnabled) startNativeChatService(ChatKeepAliveService.ACTION_READY);
        if (web != null) web.evaluateJavascript("window.mochiNeteaseSetForeground&&window.mochiNeteaseSetForeground(true)", null);
        refreshState();
        main.removeCallbacks(progressTick);
        main.post(progressTick);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String tag = intent.getStringExtra(CHAT_NOTIFY_TAG_EXTRA);
        if (tag != null && !tag.isEmpty()) {
            pendingChatNotificationTag = tag;
            dispatchPendingChatNotification();
        }
    }
    private void dispatchPendingChatNotification() {
        if (destroyed || !webPageReady || web == null || pendingChatNotificationTag == null) return;
        String tag = pendingChatNotificationTag;
        pendingChatNotificationTag = null;
        web.evaluateJavascript("window.__ciciNativeNotificationTag=" + JSONObject.quote(tag)
            + ";if(window.ciciHandleNativeNotification){window.ciciHandleNativeNotification(window.__ciciNativeNotificationTag);window.__ciciNativeNotificationTag='';}", null);
    }
    @Override protected void onPause() {
        resumed = false;
        if (nativeChatEnabled) startNativeChatService(ChatKeepAliveService.ACTION_BACKGROUND);
        if (nativeVoiceToken != null) stopNativeVoice(nativeVoiceToken);
        if (web != null) web.evaluateJavascript("window.mochiNeteaseSetForeground&&window.mochiNeteaseSetForeground(false)", null);
        main.removeCallbacks(progressTick);
        try { sessions.removeOnActiveSessionsChangedListener(sessionsChanged); } catch (Exception ignored) {}
        super.onPause();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        if (nativeVoiceToken != null) cancelNativeVoice(nativeVoiceToken);
        pendingNativeVoiceToken = null;
        musicExecutor.shutdownNow();
        fileExecutor.shutdownNow();
        if (controller != null) controller.unregisterCallback(mediaCallback);
        clearFileChooser();
        if (pendingWebPermission != null) { pendingWebPermission.deny(); pendingWebPermission = null; }
        clearExport();
        web.destroy();
        stopService(new Intent(this, PlaybackKeepAliveService.class));
        stopService(new Intent(this, ChatKeepAliveService.class));
        visible.clear();
        super.onDestroy();
    }

    private final class PlaybackGuardBridge {
        @JavascriptInterface public void setActive(boolean active) {
            main.post(() -> {
                if (destroyed) return;
                Intent intent = new Intent(MainActivity.this, PlaybackKeepAliveService.class);
                intent.setAction(active ? PlaybackKeepAliveService.ACTION_PLAY : PlaybackKeepAliveService.ACTION_STOP);
                try {
                    if (active) startForegroundService(intent);
                    else startService(intent);
                } catch (Exception ignored) {
                    if (!active) stopService(intent);
                }
            });
        }
    }

    private void startNativeChatService(String action) {
        Intent intent = new Intent(this, ChatKeepAliveService.class);
        intent.setAction(action);
        try {
            if (ChatKeepAliveService.ACTION_READY.equals(action)) startForegroundService(intent);
            else startService(intent);
        } catch (Exception ignored) {}
    }

    private final class ChatKeepAliveBridge {
        @JavascriptInterface public void setActive(boolean active) {
            main.post(() -> {
                if (destroyed) return;
                nativeChatEnabled = active;
                if (active) startNativeChatService(resumed
                    ? ChatKeepAliveService.ACTION_READY : ChatKeepAliveService.ACTION_BACKGROUND);
                else stopService(new Intent(MainActivity.this, ChatKeepAliveService.class));
            });
        }
    }

    private final class ChatNotificationBridge {
        @JavascriptInterface public String permissionState() {
            return Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
                ? "granted" : "default";
        }

        @JavascriptInterface public void requestPermission() {
            if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
            main.post(() -> {
                if (!destroyed && resumed) requestPermissions(
                    new String[] { Manifest.permission.POST_NOTIFICATIONS }, CHAT_NOTIFY_PERMISSION_REQUEST);
            });
        }

        @JavascriptInterface public boolean notify(String title, String body, String tag) {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false;
            try {
                NotificationManager manager = getSystemService(NotificationManager.class);
                manager.createNotificationChannel(new NotificationChannel(
                    CHAT_NOTIFY_CHANNEL, "聊天消息", NotificationManager.IMPORTANCE_HIGH));
                Intent open = new Intent(MainActivity.this, MainActivity.class);
                open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                if (tag != null && !tag.isEmpty()) open.putExtra(CHAT_NOTIFY_TAG_EXTRA, tag);
                int notificationId = chatNotificationIds.incrementAndGet();
                PendingIntent tap = PendingIntent.getActivity(MainActivity.this, notificationId, open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                Notification notice = new Notification.Builder(MainActivity.this, CHAT_NOTIFY_CHANNEL)
                    .setSmallIcon(android.R.drawable.ic_dialog_email)
                    .setContentTitle(title == null ? "CiCi传讯" : title)
                    .setContentText(body == null ? "收到新消息" : body)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setContentIntent(tap)
                    .setAutoCancel(true)
                    .build();
                manager.notify(notificationId, notice);
                return true;
            } catch (Exception ignored) { return false; }
        }
    }

    private boolean accessGranted() {
        String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        return enabled != null && enabled.contains(getPackageName() + "/");
    }

    private void clearExport() {
        if (exportTemp != null) exportTemp.delete();
        exportTemp = null;
        exportToken = null;
        exportName = null;
        exportMime = null;
    }
    private void refreshState() {
        if (Looper.myLooper() != Looper.getMainLooper()) { main.post(this::refreshState); return; }
        MediaController found = null;
        if (accessGranted()) {
            try {
                List<MediaController> all = sessions.getActiveSessions(listener);
                for (MediaController item : all) {
                    if (NETEASE_PACKAGE.equals(item.getPackageName())) { found = item; break; }
                }
                sessions.removeOnActiveSessionsChangedListener(sessionsChanged);
                sessions.addOnActiveSessionsChangedListener(sessionsChanged, listener, main);
            } catch (SecurityException ignored) {}
        }
        if (controller != found) {
            if (controller != null) controller.unregisterCallback(mediaCallback);
            controller = found;
            if (controller != null) controller.registerCallback(mediaCallback, main);
        }
        sendState(true);
    }

    private void sendState(boolean includeCover) {
        if (web == null) return;
        try {
            JSONObject out = new JSONObject();
            boolean granted = accessGranted();
            out.put("access", granted);
            out.put("active", granted && controller != null);
            if (granted && controller != null) {
                MediaMetadata meta = controller.getMetadata();
                PlaybackState playback = controller.getPlaybackState();
                out.put("playing", playback != null && playback.getState() == PlaybackState.STATE_PLAYING);
                out.put("canSkipNext", playback != null && (playback.getActions() & PlaybackState.ACTION_SKIP_TO_NEXT) != 0);
                out.put("canSkipToQueueItem", playback != null && (playback.getActions() & PlaybackState.ACTION_SKIP_TO_QUEUE_ITEM) != 0);
                out.put("activeQueueId", playback == null ? "" : String.valueOf(playback.getActiveQueueItemId()));
                if (meta != null) {
                    out.put("title", meta.getString(MediaMetadata.METADATA_KEY_TITLE));
                    out.put("artist", meta.getString(MediaMetadata.METADATA_KEY_ARTIST));
                    out.put("mediaId", meta.getString(MediaMetadata.METADATA_KEY_MEDIA_ID));
                    out.put("duration", Math.max(0, meta.getLong(MediaMetadata.METADATA_KEY_DURATION)));
                    if (includeCover) {
                        String art = meta.getString(MediaMetadata.METADATA_KEY_ART_URI);
                        if (art == null) art = meta.getString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI);
                        if (art != null && art.startsWith("https://")) out.put("cover", art);
                        else {
                            Bitmap bitmap = meta.getBitmap(MediaMetadata.METADATA_KEY_ART);
                            if (bitmap == null) bitmap = meta.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
                            if (bitmap != null) {
                                Bitmap small = Bitmap.createScaledBitmap(bitmap, 128, 128, true);
                                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                                small.compress(Bitmap.CompressFormat.JPEG, 65, bytes);
                                out.put("cover", "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                            } else out.put("cover", "");
                        }
                    }
                }
                if (playback != null) {
                    long position = playback.getPosition();
                    if (playback.getState() == PlaybackState.STATE_PLAYING && position >= 0)
                        position += (long) ((android.os.SystemClock.elapsedRealtime() - playback.getLastPositionUpdateTime()) * playback.getPlaybackSpeed());
                    out.put("position", Math.max(0, position));
                }
                if (includeCover) {
                    JSONArray items = new JSONArray();
                    List<MediaSession.QueueItem> queue = controller.getQueue();
                    if (queue != null) {
                        for (MediaSession.QueueItem item : queue) {
                            if (items.length() >= 500) break;
                            if (item == null) continue;
                            MediaDescription description = item.getDescription();
                            if (description == null) continue;
                            JSONObject entry = new JSONObject();
                            entry.put("id", String.valueOf(item.getQueueId()));
                            entry.put("mediaId", description.getMediaId());
                            entry.put("title", description.getTitle() == null ? "" : description.getTitle().toString());
                            entry.put("artist", description.getSubtitle() == null ? "" : description.getSubtitle().toString());
                            Uri icon = description.getIconUri();
                            entry.put("cover", icon != null && "https".equalsIgnoreCase(icon.getScheme()) ? icon.toString() : "");
                            items.put(entry);
                        }
                    }
                    out.put("queue", items);
                    out.put("queueCount", queue == null ? 0 : queue.size());
                    CharSequence queueTitle = controller.getQueueTitle();
                    out.put("queueTitle", queueTitle == null ? "" : queueTitle.toString());
                }
            }
            web.evaluateJavascript("window.mochiNeteaseUpdate&&window.mochiNeteaseUpdate(" + JSONObject.quote(out.toString()) + ")", null);
        } catch (Exception ignored) {}
    }

    private class RemoteBridge {
        @JavascriptInterface public void refresh() { main.post(MainActivity.this::refreshState); }
        @JavascriptInterface public void requestAccess() {
            main.post(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                    startActivity(intent);
                } catch (ActivityNotFoundException ignored) {}
            });
        }
        @JavascriptInterface public void command(String action) {
            main.post(() -> {
                refreshState();
                if (controller == null) return;
                MediaController.TransportControls control = controller.getTransportControls();
                switch (action) {
                    case "play": control.play(); break;
                    case "pause": control.pause(); break;
                    case "next": control.skipToNext(); break;
                    case "previous": control.skipToPrevious(); break;
                    default: return;
                }
                main.postDelayed(MainActivity.this::refreshState, 350);
            });
        }
        @JavascriptInterface public void seekTo(long positionMs) {
            main.post(() -> {
                refreshState();
                if (controller == null) return;
                MediaMetadata metadata = controller.getMetadata();
                long duration = metadata == null ? 0 : metadata.getLong(MediaMetadata.METADATA_KEY_DURATION);
                if (duration > 0) controller.getTransportControls().seekTo(Math.max(0, Math.min(duration, positionMs)));
            });
        }
        @JavascriptInterface public void skipToQueueItem(String queueId) {
            main.post(() -> {
                refreshState();
                if (controller == null || queueId == null) return;
                PlaybackState playback = controller.getPlaybackState();
                if (playback == null || (playback.getActions() & PlaybackState.ACTION_SKIP_TO_QUEUE_ITEM) == 0) return;
                try {
                    long target = Long.parseLong(queueId);
                    List<MediaSession.QueueItem> queue = controller.getQueue();
                    if (queue == null) return;
                    boolean found = false;
                    for (MediaSession.QueueItem item : queue) {
                        if (item != null && item.getQueueId() == target) { found = true; break; }
                    }
                    if (!found) return;
                    controller.getTransportControls().skipToQueueItem(target);
                    main.postDelayed(MainActivity.this::refreshState, 350);
                } catch (NumberFormatException ignored) {}
            });
        }
    }

    private class OnlineMusicBridge {
        @JavascriptInterface public void request(String token, String type, String value, String endpoint) {
            if (destroyed || token == null || token.length() > 80) return;
            musicExecutor.execute(() -> {
                JSONObject result;
                try { result = NeteaseOnlineMusicApi.request(type, value, endpoint); }
                catch (Exception ignored) {
                    result = new JSONObject();
                    try { result.put("code", 500); result.put("data", JSONObject.NULL); }
                    catch (Exception impossible) { return; }
                }
                String output = result.toString();
                main.post(() -> {
                    if (destroyed || web == null) return;
                    web.evaluateJavascript("window.ciciOnlineMusicResponse&&window.ciciOnlineMusicResponse("
                            + JSONObject.quote(token) + "," + JSONObject.quote(output) + ")", null);
                });
            });
        }
    }

    private class MailAiBridge {
        @JavascriptInterface public void interpret(String token, String endpoint, String model,
                                                   String apiKey, String systemPrompt, String userPrompt) {
            if (destroyed || token == null || token.length() > 80) return;
            musicExecutor.execute(() -> {
                JSONObject result;
                try { result = MailAiApi.interpret(endpoint, model, apiKey, systemPrompt, userPrompt); }
                catch (Exception error) {
                    result = new JSONObject();
                    try {
                        result.put("ok", false);
                        result.put("error", error.getMessage() == null ? "接口连接失败" : error.getMessage());
                    } catch (Exception impossible) { return; }
                }
                String output = result.toString();
                main.post(() -> {
                    if (destroyed || web == null) return;
                    web.evaluateJavascript("window.ciciMailAiResponse&&window.ciciMailAiResponse("
                            + JSONObject.quote(token) + "," + JSONObject.quote(output) + ")", null);
                });
            });
        }
    }

    private class VideoInfoBridge {
        @JavascriptInterface public void resolve(String token, String shareUrl) {
            if (destroyed || token == null || token.length() > 80) return;
            musicExecutor.execute(() -> {
                JSONObject result;
                try { result = ShortVideoMetadata.resolve(shareUrl); }
                catch (Exception ignored) {
                    result = new JSONObject();
                    try { result.put("title", ""); result.put("durationSec", 0); }
                    catch (Exception impossible) { return; }
                }
                String output = result.toString();
                main.post(() -> {
                    if (destroyed || web == null) return;
                    web.evaluateJavascript("window.ciciVideoInfoResponse&&window.ciciVideoInfoResponse("
                            + JSONObject.quote(token) + "," + JSONObject.quote(output) + ")", null);
                });
            });
        }
    }

    private class FileSaveBridge {
        private File staging;
        private String token;
        private String name;
        private String mime;
        private FileOutputStream stream;

        @JavascriptInterface public synchronized String begin(String filename, String contentType) {
            if (token != null || exportToken != null) return "";
            try {
                name = filename == null ? "mochi-backup.json" : filename.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (name.isEmpty()) name = "mochi-backup.json";
                mime = contentType == null || contentType.isEmpty() ? "application/octet-stream" : contentType.split(";", 2)[0];
                token = UUID.randomUUID().toString();
                staging = File.createTempFile("mochi-export-", ".tmp", getCacheDir());
                stream = new FileOutputStream(staging);
                return token;
            } catch (Exception e) { reset(); return ""; }
        }
        @JavascriptInterface public synchronized boolean append(String session, String base64) {
            if (stream == null || !token.equals(session)) return false;
            try {
                stream.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) { reset(); return false; }
        }
        @JavascriptInterface public synchronized boolean finish(String session) {
            if (stream == null || !token.equals(session)) return false;
            try { stream.close(); } catch (Exception e) { reset(); return false; }
            stream = null;
            exportTemp = staging;
            exportToken = token;
            exportName = name;
            exportMime = mime;
            staging = null; token = null; name = null; mime = null;
            main.post(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    intent.setType(exportMime);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.putExtra(Intent.EXTRA_TITLE, exportName);
                    startActivityForResult(intent, 58);
                } catch (Exception e) {
                    String failed = exportToken;
                    clearExport();
                    web.evaluateJavascript("window.mochiNativeSaveResolve&&window.mochiNativeSaveResolve(" + JSONObject.quote(failed) + ",false)", null);
                }
            });
            return true;
        }
        @JavascriptInterface public synchronized void abort(String session) {
            if (session != null && session.equals(token)) reset();
        }
        private void reset() {
            try { if (stream != null) stream.close(); } catch (Exception ignored) {}
            if (staging != null) staging.delete();
            stream = null; staging = null; token = null; name = null; mime = null;
        }
    }
}
