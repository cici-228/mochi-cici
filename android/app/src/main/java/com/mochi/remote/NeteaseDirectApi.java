package com.mochi.remote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/** Phone-side NetEase client. Its login credential is never exposed to the WebView. */
final class NeteaseDirectApi {
    interface Reply { void send(String token, String json); }

    private static final String API = "https://interface.music.163.com";
    private static final String WEB = "https://music.163.com";
    private static final String PREFS = "cici-netease-direct-v1";
    private static final String KEY_ALIAS = "cici-netease-direct-cookie-v1";
    private static final String PRESET_KEY = "0CoJUm6Qyw8W8jud";
    private static final String IV = "0102030405060708";
    private static final String RSA_MODULUS =
            "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
    private static final String USER_AGENT =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

    private final SharedPreferences prefs;
    private final ExecutorService executor;
    private final Reply reply;
    private final SecureRandom random = new SecureRandom();
    private final LinkedHashMap<String, String> qrCookies = new LinkedHashMap<>();
    private String qrKey = "";

    NeteaseDirectApi(Context context, ExecutorService executor, Reply reply) {
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        this.executor = executor;
        this.reply = reply;
    }

    @JavascriptInterface public void request(String token, String action, String payload) {
        if (token == null || token.length() > 80 || action == null || action.length() > 40) return;
        executor.execute(() -> {
            JSONObject output = new JSONObject();
            try {
                JSONObject input = payload == null || payload.isEmpty() ? new JSONObject() : new JSONObject(payload);
                output.put("ok", true).put("data", run(action, input));
            } catch (Exception error) {
                try { output.put("ok", false).put("error", safeError(error)); }
                catch (Exception ignored) { return; }
            }
            reply.send(token, output.toString());
        });
    }

    private Object run(String action, JSONObject input) throws Exception {
        switch (action) {
            case "status": return status();
            case "test": return apiPost("/api/search/get/", new JSONObject().put("s", "音乐")
                    .put("type", 1).put("limit", 1), false);
            case "beginLogin": {
                qrCookies.clear();
                JSONObject result = qrGet("/api/login/qrcode/unikey?type=1");
                JSONObject data = result.optJSONObject("data");
                qrKey = result.optString("unikey", "");
                if (qrKey.isEmpty() && data != null) qrKey = data.optString("unikey", "");
                if (qrKey.isEmpty()) throw new Exception("网易云二维码接口返回成功，但缺少二维码标识");
                return new JSONObject().put("key", qrKey)
                        .put("qrurl", WEB + "/login?codekey=" + URLEncoder.encode(qrKey, "UTF-8"));
            }
            case "pollLogin": {
                String key = required(input.optString("key"), 150);
                if (!key.equals(qrKey)) throw new Exception("登录二维码已更新，请重新扫码");
                JSONObject result = qrGet("/api/login/qrcode/client/login?key="
                        + URLEncoder.encode(key, "UTF-8") + "&type=1");
                int code = result.optInt("code");
                if (code == 803) {
                    String musicU = qrCookies.get("MUSIC_U");
                    if (musicU == null || musicU.isEmpty()) musicU = parseCookieValue(result.optString("cookie"), "MUSIC_U");
                    if (musicU == null || musicU.isEmpty()) throw new Exception("扫码成功但未取得网易云登录凭证");
                    putCookie(musicU);
                    prefs.edit().remove("userId").remove("playlistId").apply();
                    qrKey = "";
                    qrCookies.clear();
                }
                return new JSONObject().put("status", code).put("message", result.optString("message"))
                        .put("loggedIn", code == 803);
            }
            case "playlists": {
                String userId = prefs.getString("userId", "");
                if (userId.isEmpty()) {
                    JSONObject account = apiPost("/api/nuser/account/get", new JSONObject(), true);
                    JSONObject profile = account.optJSONObject("profile");
                    JSONObject user = account.optJSONObject("account");
                    Object id = profile != null ? profile.opt("userId") : user == null ? null : user.opt("id");
                    if (id == null) throw new Exception("无法识别网易云账号，请重新扫码登录");
                    userId = String.valueOf(id);
                    prefs.edit().putString("userId", userId).apply();
                }
                JSONObject result = apiPost("/api/user/playlist", new JSONObject().put("uid", userId)
                        .put("limit", 500).put("offset", 0), true);
                JSONArray source = result.optJSONArray("playlist");
                JSONArray own = new JSONArray();
                if (source != null) for (int i = 0; i < source.length(); i++) {
                    JSONObject item = source.optJSONObject(i);
                    if (item == null) continue;
                    JSONObject creator = item.optJSONObject("creator");
                    if (creator == null || !userId.equals(String.valueOf(creator.opt("userId")))) continue;
                    own.put(new JSONObject().put("id", item.opt("id")).put("name", item.optString("name")));
                }
                return new JSONObject().put("records", own);
            }
            case "choosePlaylist": {
                String id = required(input.optString("playlistId"), 80);
                if (!id.matches("[0-9]+")) throw new Exception("歌单编号无效");
                // The user can only choose an account-owned playlist returned by playlists.
                JSONArray records = ((JSONObject) run("playlists", new JSONObject())).optJSONArray("records");
                boolean owned = false;
                if (records != null) for (int i = 0; i < records.length(); i++)
                    if (id.equals(String.valueOf(records.getJSONObject(i).opt("id")))) owned = true;
                if (!owned) throw new Exception("只能选择自己创建的网易云歌单");
                prefs.edit().putString("playlistId", id).apply();
                return status();
            }
            case "searchSong": return apiPost("/api/search/get/", new JSONObject()
                    .put("s", required(input.optString("query"), 80)).put("type", 1)
                    .put("limit", 30).put("offset", 0), true);
            case "searchPlaylist": return apiPost("/api/search/get/", new JSONObject()
                    .put("s", required(input.optString("query"), 80)).put("type", 1000)
                    .put("limit", 12).put("offset", 0), true);
            case "dailySongs": return accountWebPost("/weapi/v3/discovery/recommend/songs", new JSONObject());
            case "heartSongs": {
                String songId = numeric(input.optString("songId"));
                String playlistId = numeric(input.optString("playlistId"));
                return apiPost("/api/playmode/intelligence/list", new JSONObject()
                        .put("c", songId).put("type", "fromPlayOne")
                        .put("playlistId", playlistId).put("startMusicId", songId)
                        .put("count", 30), true);
            }
            case "heartSeed": {
                JSONObject account = apiPost("/api/nuser/account/get", new JSONObject(), true);
                JSONObject profile = account.optJSONObject("profile");
                JSONObject user = account.optJSONObject("account");
                Object userId = profile != null ? profile.opt("userId") : user == null ? null : user.opt("id");
                if (userId == null) throw new Exception("无法识别网易云账号，请重新扫码登录");
                JSONObject result = apiPost("/api/user/playlist", new JSONObject()
                        .put("uid", String.valueOf(userId)).put("limit", 100).put("offset", 0), true);
                JSONArray lists = result.optJSONArray("playlist");
                JSONObject liked = null;
                if (lists != null) for (int i = 0; i < lists.length(); i++) {
                    JSONObject item = lists.optJSONObject(i);
                    if (item != null && item.optInt("specialType") == 5) { liked = item; break; }
                }
                if (liked == null) throw new Exception("没有找到“我喜欢的音乐”歌单，暂时无法开启心动模式");
                String playlistId = String.valueOf(liked.opt("id"));
                JSONObject detail = apiPost("/api/v6/playlist/detail", new JSONObject()
                        .put("id", playlistId).put("n", 100).put("s", 0), true).optJSONObject("playlist");
                JSONArray songs = detail == null ? null : detail.optJSONArray("tracks");
                if (songs == null || songs.length() == 0) throw new Exception("“我喜欢的音乐”中没有可用的起始歌曲");
                String current = input.optString("songId");
                String seed = "";
                for (int i = 0; i < songs.length(); i++) {
                    JSONObject song = songs.optJSONObject(i);
                    if (song == null) continue;
                    String id = String.valueOf(song.opt("id"));
                    if (seed.isEmpty()) seed = id;
                    if (id.equals(current)) { seed = id; break; }
                }
                if (seed.isEmpty()) throw new Exception("“我喜欢的音乐”中没有可用的起始歌曲");
                return new JSONObject().put("songId", seed).put("playlistId", playlistId);
            }
            case "songUrl": {
                String id = numeric(input.optString("songId"));
                return apiPost("/api/song/enhance/player/url/v1", new JSONObject()
                        .put("ids", new JSONArray().put(id).toString())
                        .put("level", "standard").put("encodeType", "mp3"), true);
            }
            case "songDetail": {
                String id = numeric(input.optString("songId"));
                return apiPost("/api/v3/song/detail", new JSONObject()
                        .put("c", new JSONArray().put(new JSONObject().put("id", id)).toString()), true);
            }
            case "songLyric": return apiPost("/api/song/lyric/v1", new JSONObject()
                    .put("id", numeric(input.optString("songId")))
                    .put("lv", 0).put("kv", 0).put("tv", 0), true);
            case "fallbackUrl": return MeiFallbackResolver.resolve(input);
            case "playlistSongs": {
                String id = required(input.optString("playlistId"), 80);
                if (!id.matches("[0-9]+")) throw new Exception("歌单编号无效");
                return apiPost("/api/v6/playlist/detail", new JSONObject().put("id", id)
                        .put("n", 100).put("s", 0), true).getJSONObject("playlist");
            }
            case "addSong": {
                String playlistId = prefs.getString("playlistId", "");
                if (playlistId.isEmpty()) throw new Exception("请先选择自己的网易云歌单");
                String songId = required(input.optString("songId"), 80);
                if (!songId.matches("[0-9]+")) throw new Exception("歌曲编号无效");
                return apiPost("/api/playlist/manipulate/tracks", new JSONObject()
                        .put("op", "add").put("pid", playlistId)
                        .put("trackIds", new JSONArray().put(songId).toString())
                        .put("imme", true), true);
            }
            case "logout":
                putCookie("");
                prefs.edit().remove("playlistId").remove("userId").apply();
                qrKey = "";
                qrCookies.clear();
                return status();
            default: throw new Exception("不支持的网易云操作");
        }
    }

    private JSONObject status() throws Exception {
        return new JSONObject().put("available", true).put("configured", true)
                .put("loggedIn", !getCookie().isEmpty())
                .put("playlistId", prefs.getString("playlistId", ""));
    }

    private JSONObject apiPost(String path, JSONObject params, boolean authenticated) throws Exception {
        String cookie = getCookie();
        if (authenticated && cookie.isEmpty()) throw new Exception("请先扫码登录网易云账号");
        LinkedHashMap<String, String> form = new LinkedHashMap<>();
        for (java.util.Iterator<String> keys = params.keys(); keys.hasNext();) {
            String key = keys.next();
            form.put(key, String.valueOf(params.get(key)));
        }
        return send(API + path, form, cookie.isEmpty() ? "" : "MUSIC_U=" + cookie + "; os=android; appver=9.4.32", false);
    }

    private JSONObject webPost(String path, JSONObject params) throws Exception {
        params.put("csrf_token", qrCookies.containsKey("__csrf") ? qrCookies.get("__csrf") : "");
        String json = params.toString();
        String key = randomKey();
        String once = Base64.encodeToString(aesCbc(json.getBytes(StandardCharsets.UTF_8), PRESET_KEY), Base64.NO_WRAP);
        String encrypted = Base64.encodeToString(aesCbc(once.getBytes(StandardCharsets.UTF_8), key), Base64.NO_WRAP);
        byte[] reversed = new StringBuilder(key).reverse().toString().getBytes(StandardCharsets.UTF_8);
        String secKey = new BigInteger(1, reversed).modPow(BigInteger.valueOf(65537),
                new BigInteger(RSA_MODULUS, 16)).toString(16);
        while (secKey.length() < 256) secKey = "0" + secKey;
        LinkedHashMap<String, String> form = new LinkedHashMap<>();
        form.put("params", encrypted);
        form.put("encSecKey", secKey);
        StringBuilder cookie = new StringBuilder("os=pc; appver=3.1.17");
        for (Map.Entry<String, String> entry : qrCookies.entrySet())
            cookie.append("; ").append(entry.getKey()).append('=').append(entry.getValue());
        return send(WEB + path, form, cookie.toString(), true);
    }

    private JSONObject accountWebPost(String path, JSONObject params) throws Exception {
        String musicU = getCookie();
        if (musicU.isEmpty()) throw new Exception("请先扫码登录网易云账号");
        params.put("csrf_token", "");
        String key = randomKey();
        String once = Base64.encodeToString(aesCbc(params.toString().getBytes(StandardCharsets.UTF_8), PRESET_KEY), Base64.NO_WRAP);
        String encrypted = Base64.encodeToString(aesCbc(once.getBytes(StandardCharsets.UTF_8), key), Base64.NO_WRAP);
        String secKey = new BigInteger(1, new StringBuilder(key).reverse().toString().getBytes(StandardCharsets.UTF_8))
                .modPow(BigInteger.valueOf(65537), new BigInteger(RSA_MODULUS, 16)).toString(16);
        while (secKey.length() < 256) secKey = "0" + secKey;
        LinkedHashMap<String, String> form = new LinkedHashMap<>();
        form.put("params", encrypted);
        form.put("encSecKey", secKey);
        return send(WEB + path, form, "os=pc; appver=3.1.17; MUSIC_U=" + musicU, false);
    }

    private byte[] aesCbc(byte[] input, String key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"),
                new IvParameterSpec(IV.getBytes(StandardCharsets.UTF_8)));
        return cipher.doFinal(input);
    }

    private String randomKey() {
        String chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        StringBuilder key = new StringBuilder();
        for (int i = 0; i < 16; i++) key.append(chars.charAt(random.nextInt(chars.length())));
        return key.toString();
    }

    private JSONObject send(String url, Map<String, String> form, String cookie, boolean qr) throws Exception {
        return send(url, form, cookie, qr, false);
    }

    private JSONObject qrGet(String path) throws Exception {
        StringBuilder cookie = new StringBuilder("os=pc; appver=3.1.17");
        for (Map.Entry<String, String> entry : qrCookies.entrySet())
            cookie.append("; ").append(entry.getKey()).append('=').append(entry.getValue());
        return send(WEB + path, new LinkedHashMap<>(), cookie.toString(), true, true);
    }

    private JSONObject send(String url, Map<String, String> form, String cookie, boolean qr, boolean get) throws Exception {
        StringBuilder body = new StringBuilder();
        for (Map.Entry<String, String> entry : form.entrySet()) {
            if (body.length() > 0) body.append('&');
            body.append(URLEncoder.encode(entry.getKey(), "UTF-8")).append('=')
                    .append(URLEncoder.encode(entry.getValue(), "UTF-8"));
        }
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod(get ? "GET" : "POST");
        conn.setConnectTimeout(12000);
        conn.setReadTimeout(20000);
        conn.setDoOutput(!get);
        if (!get) conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        conn.setRequestProperty("User-Agent", USER_AGENT);
        conn.setRequestProperty("Referer", WEB);
        if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
        try {
            if (!get) try (OutputStream out = conn.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            int http = conn.getResponseCode();
            if (http >= 300 && http < 400) throw new Exception("网易云请求被重定向");
            if (qr) absorbCookies(conn.getHeaderFields());
            InputStream stream = http < 400 ? conn.getInputStream() : conn.getErrorStream();
            if (stream == null) throw new Exception("网易云未返回数据（HTTP " + http + "）");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = stream) {
                byte[] chunk = new byte[8192]; int n;
                while ((n = input.read(chunk)) != -1) {
                    if (bytes.size() + n > 4 * 1024 * 1024) throw new Exception("网易云响应过大");
                    bytes.write(chunk, 0, n);
                }
            }
            JSONObject result = new JSONObject(bytes.toString("UTF-8"));
            int code = result.optInt("code", http);
            if (http >= 400 || (code != 200 && !(qr && code >= 800 && code <= 803)))
                throw new Exception("网易云接口 " + code + "：" + result.optString("message", "请求失败"));
            return result;
        } finally { conn.disconnect(); }
    }

    private void absorbCookies(Map<String, List<String>> headers) {
        for (Map.Entry<String, List<String>> header : headers.entrySet()) {
            if (header.getKey() == null || !"Set-Cookie".equalsIgnoreCase(header.getKey())) continue;
            for (String line : header.getValue()) {
                int end = line.indexOf(';');
                String first = (end < 0 ? line : line.substring(0, end)).trim();
                int equals = first.indexOf('=');
                if (equals > 0 && equals < first.length() - 1)
                    qrCookies.put(first.substring(0, equals), first.substring(equals + 1));
            }
        }
    }

    private static String parseCookieValue(String cookie, String name) {
        for (String part : cookie.split(";")) {
            String item = part.trim();
            if (item.startsWith(name + "=")) return item.substring(name.length() + 1);
        }
        return "";
    }

    private static String required(String raw, int max) throws Exception {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty() || value.length() > max) throw new Exception("参数为空或过长");
        return value;
    }

    private static String numeric(String raw) throws Exception {
        String value = required(raw, 80);
        if (!value.matches("[0-9]+")) throw new Exception("网易云歌曲或歌单编号无效");
        return value;
    }

    private SecretKey encryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(KEY_ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            generator.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    private void putCookie(String cookie) throws Exception {
        if (cookie == null || cookie.isEmpty()) { prefs.edit().remove("cookie").apply(); return; }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
        byte[] encrypted = cipher.doFinal(cookie.getBytes(StandardCharsets.UTF_8));
        prefs.edit().putString("cookie", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":"
                + Base64.encodeToString(encrypted, Base64.NO_WRAP)).apply();
    }

    private String getCookie() throws Exception {
        String saved = prefs.getString("cookie", "");
        if (saved.isEmpty()) return "";
        String[] parts = saved.split(":", 2);
        if (parts.length != 2) throw new Exception("登录数据损坏，请重新扫码");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(),
                new GCMParameterSpec(128, Base64.decode(parts[0], Base64.DEFAULT)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.DEFAULT)), StandardCharsets.UTF_8);
    }

    private static String safeError(Exception error) {
        String message = error.getMessage();
        if (message == null || message.length() > 200) return "网易云接口调用失败";
        return message.replaceAll("[\\r\\n]", " ");
    }
}
