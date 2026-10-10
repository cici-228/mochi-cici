package com.mochi.remote;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * Android port of the search, URL and lyric operations in jiuhunwl/music_jx.
 * Source: https://github.com/jiuhunwl/music_jx (MIT license).
 * This bridge never accepts account passwords or stores a login cookie.
 */
final class NeteaseOnlineMusicApi {
    private static final String HOST = "https://interface3.music.163.com";
    private static final String UA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/2.10.2.200154";
    private static final byte[] AES_KEY = "e82ckenh8dichen8".getBytes(StandardCharsets.US_ASCII);
    private static final String DELIMITER = "-36cd479b6b5-";

    private NeteaseOnlineMusicApi() {}

    static JSONObject request(String type, String value) throws Exception {
        return request(type, value, "");
    }

    static JSONObject request(String type, String value, String endpoint) throws Exception {
        if (value == null || value.trim().isEmpty() || value.length() > 120) throw new IllegalArgumentException("Invalid music request");
        if (!"search".equals(type) && !"style".equals(type) && !"url".equals(type) && !"lyric".equals(type))
            throw new IllegalArgumentException("Unsupported music request");
        // 曲风通过歌单选歌；兼容 music_jx 的自填接口只提供歌曲搜索，不能用它代替歌单搜索。
        if ("style".equals(type)) return styleSearch(value.trim());
        if (endpoint != null && !endpoint.trim().isEmpty()) return externalRequest(type, value.trim(), endpoint.trim());
        switch (type) {
            case "search": return search(value.trim());
            case "url": return address(value.trim());
            case "lyric": return lyric(value.trim());
            default: throw new IllegalArgumentException("Unsupported music request");
        }
    }

    // 用户填写的 HTTPS 接口须兼容 music_jx 的 type / keywords / id 参数及 JSON 结构。
    private static JSONObject externalRequest(String type, String value, String endpoint) throws Exception {
        if (endpoint.length() > 2048 || endpoint.contains("#")) throw new IllegalArgumentException("Invalid music endpoint");
        URL base = new URL(endpoint);
        if (!"https".equalsIgnoreCase(base.getProtocol()) || base.getHost().isEmpty() || base.getUserInfo() != null)
            throw new IllegalArgumentException("Music endpoint must use HTTPS");
        String separator = endpoint.contains("?") ? (endpoint.endsWith("?") || endpoint.endsWith("&") ? "" : "&") : "?";
        String parameter = "search".equals(type) ? "keywords" : "id";
        String requestUrl = endpoint + separator + "type=" + type + "&" + parameter + "=" + URLEncoder.encode(value, "UTF-8");
        HttpURLConnection connection = (HttpURLConnection) new URL(requestUrl).openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        try { return readJson(connection); }
        finally { connection.disconnect(); }
    }

    private static JSONObject search(String keyword) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("s", keyword);
        payload.put("type", 1);
        payload.put("limit", 20);
        payload.put("offset", 0);
        JSONObject raw = eapi("/eapi/cloudsearch/pc", payload);
        if (raw.optInt("code") != 200) throw new IllegalStateException("Music search failed");
        JSONObject result = raw.optJSONObject("result");
        JSONArray source = result == null ? null : result.optJSONArray("songs");
        JSONArray songs = new JSONArray();
        if (source != null) for (int i = 0; i < source.length(); i++) {
            JSONObject item = source.optJSONObject(i);
            if (item == null) continue;
            JSONObject song = new JSONObject();
            song.put("id", item.optLong("id"));
            song.put("name", item.optString("name"));
            JSONArray artists = item.optJSONArray("ar");
            StringBuilder names = new StringBuilder();
            if (artists != null) for (int j = 0; j < artists.length(); j++) {
                JSONObject artist = artists.optJSONObject(j);
                if (artist == null) continue;
                String name = artist.optString("name");
                if (name.isEmpty()) continue;
                if (names.length() > 0) names.append('/');
                names.append(name);
            }
            song.put("artists", names.toString());
            JSONObject album = item.optJSONObject("al");
            song.put("album", album == null ? "" : album.optString("name"));
            song.put("picUrl", album == null ? "" : album.optString("picUrl"));
            song.put("duration", item.optLong("dt"));
            song.put("fee", item.optInt("fee", -1));
            songs.put(song);
        }
        songs = preferFreeSongs(songs, keyword);
        JSONObject data = new JSONObject();
        data.put("songs", songs);
        data.put("total", result == null ? 0 : result.optLong("songCount"));
        return ok(data);
    }

    private static JSONObject styleSearch(String keyword) throws Exception {
        String searchUrl = "https://music.163.com/api/search/get/web?s="
                + URLEncoder.encode(keyword, "UTF-8") + "&type=1000&limit=20&offset=0";
        JSONObject found = getJson(searchUrl);
        if (found.optInt("code") != 200) throw new IllegalStateException("Playlist search failed");
        JSONObject result = found.optJSONObject("result");
        JSONArray playlists = result == null ? null : result.optJSONArray("playlists");
        JSONArray songs = new JSONArray();
        if (playlists != null) {
            // 优先使用标题明确包含风格词的歌单，避免搜索排序把无关热门歌单放在前面。
            for (int pass = 0; pass < 2 && songs.length() == 0; pass++) {
                for (int i = 0; i < playlists.length() && songs.length() == 0; i++) {
                    JSONObject playlist = playlists.optJSONObject(i);
                    if (playlist == null || playlist.optLong("id") <= 0) continue;
                    int count = playlist.optInt("trackCount");
                    if (count < 3 || count > 1000) continue;
                    boolean titleMatch = containsKeyword(playlist.optString("name"), keyword);
                    if (pass == 0 ? !titleMatch : titleMatch || !containsKeyword(playlist.optString("description"), keyword)) continue;
                    try { songs = randomPlaylistSongs(playlist.optLong("id")); }
                    catch (Exception ignored) { /* 尝试下一份匹配的歌单 */ }
                }
            }
        }
        JSONObject data = new JSONObject();
        data.put("songs", songs);
        data.put("total", songs.length());
        return ok(data);
    }

    private static boolean containsKeyword(String text, String keyword) {
        return text != null && text.toLowerCase(Locale.ROOT).contains(keyword.toLowerCase(Locale.ROOT));
    }

    private static JSONArray randomPlaylistSongs(long playlistId) throws Exception {
        JSONObject detail = getJson("https://music.163.com/api/v6/playlist/detail?id=" + playlistId + "&n=10&s=0");
        if (detail.optInt("code") != 200) throw new IllegalStateException("Playlist detail failed");
        JSONObject playlist = detail.optJSONObject("playlist");
        JSONArray trackIds = playlist == null ? null : playlist.optJSONArray("trackIds");
        if (trackIds == null || trackIds.length() < 3) return new JSONArray();
        ArrayList<Long> ids = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        for (int i = 0; i < trackIds.length(); i++) {
            JSONObject item = trackIds.optJSONObject(i);
            long id = item == null ? 0 : item.optLong("id");
            if (id > 0 && seen.add(id)) ids.add(id);
        }
        if (ids.size() < 3) return new JSONArray();
        Collections.shuffle(ids, ThreadLocalRandom.current());
        JSONArray request = new JSONArray();
        // 关键词预订会在同一份搜索歌单里连续播放，保留足够多的随机候选。
        for (int i = 0; i < Math.min(ids.size(), 30); i++) {
            JSONObject item = new JSONObject();
            item.put("id", ids.get(i));
            request.put(item);
        }
        String songUrl = "https://music.163.com/api/v3/song/detail?c="
                + URLEncoder.encode(request.toString(), "UTF-8");
        JSONObject raw = getJson(songUrl);
        if (raw.optInt("code") != 200) throw new IllegalStateException("Song detail failed");
        JSONArray source = raw.optJSONArray("songs");
        JSONArray songs = new JSONArray();
        if (source == null) return songs;
        // 歌曲详情可能乱序；先恢复随机顺序，再在其中优先选非会员曲。
        for (int i = 0; i < request.length(); i++) {
            long id = request.optJSONObject(i).optLong("id");
            for (int j = 0; j < source.length(); j++) {
                JSONObject item = source.optJSONObject(j);
                if (item != null && item.optLong("id") == id) {
                    songs.put(songInfo(item));
                    break;
                }
            }
        }
        JSONArray preferred = preferFreeSongs(songs, null);
        return preferred;
    }

    private static JSONObject songInfo(JSONObject item) throws Exception {
        JSONObject song = new JSONObject();
        song.put("id", item.optLong("id"));
        song.put("name", item.optString("name"));
        JSONArray artists = item.optJSONArray("ar");
        StringBuilder names = new StringBuilder();
        if (artists != null) for (int j = 0; j < artists.length(); j++) {
            JSONObject artist = artists.optJSONObject(j);
            if (artist == null) continue;
            String name = artist.optString("name");
            if (name.isEmpty()) continue;
            if (names.length() > 0) names.append('/');
            names.append(name);
        }
        song.put("artists", names.toString());
        JSONObject album = item.optJSONObject("al");
        song.put("album", album == null ? "" : album.optString("name"));
        song.put("picUrl", album == null ? "" : album.optString("picUrl"));
        song.put("duration", item.optLong("dt"));
        song.put("fee", item.optInt("fee", -1));
        return song;
    }

    private static JSONArray preferFreeSongs(JSONArray source, String requestedName) {
        ArrayList<JSONObject> songs = new ArrayList<>();
        for (int i = 0; i < source.length(); i++) {
            JSONObject item = source.optJSONObject(i);
            if (item != null) songs.add(item);
        }
        // 指定歌名时先保留歌名匹配，再在同名结果中优先免费曲；风格歌单只按免费优先。
        songs.sort(Comparator.comparingInt(item -> {
            boolean exact = requestedName == null || item.optString("name").trim().equalsIgnoreCase(requestedName.trim());
            int fee = item.optInt("fee", -1);
            boolean free = fee == 0 || fee == 8;
            return (exact ? 0 : 2) + (free ? 0 : 1);
        }));
        JSONArray result = new JSONArray();
        for (JSONObject song : songs) result.put(song);
        return result;
    }

    private static JSONObject getJson(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(12000);
        connection.setRequestProperty("User-Agent", UA);
        connection.setRequestProperty("Referer", "https://music.163.com/");
        connection.setRequestProperty("Accept", "application/json");
        try { return readJson(connection); }
        finally { connection.disconnect(); }
    }

    private static JSONObject address(String id) throws Exception {
        if (!id.matches("[0-9]{1,20}")) throw new IllegalArgumentException("Invalid song ID");
        for (String level : new String[]{"standard", "sky", "jyeffect"}) {
            JSONObject payload = new JSONObject();
            JSONArray ids = new JSONArray();
            ids.put(id);
            payload.put("ids", ids);
            payload.put("level", level);
            payload.put("encodeType", "flac");
            if ("sky".equals(level)) payload.put("immerseType", "c51");
            JSONObject raw = eapi("/eapi/song/enhance/player/url/v1", payload);
            JSONArray data = raw.optJSONArray("data");
            if (data == null) continue;
            JSONArray playable = new JSONArray();
            for (int i = 0; i < data.length(); i++) {
                JSONObject item = data.optJSONObject(i);
                if (item == null) continue;
                String url = item.optString("url");
                if (url.isEmpty() || "null".equals(url)) continue;
                // 登录态之外取得的试听流不能作为完整歌曲加入 CiCi 歌单。
                JSONObject trial = item.optJSONObject("freeTrialInfo");
                if (trial != null) continue;
                if (url.startsWith("http://")) url = "https://" + url.substring(7);
                if (!url.startsWith("https://")) continue;
                JSONObject song = new JSONObject();
                song.put("id", item.optString("id", id));
                song.put("url", url);
                song.put("level", item.optString("level", level));
                song.put("size", item.optLong("size"));
                song.put("time", item.optLong("time"));
                playable.put(song);
            }
            if (playable.length() > 0) return ok(playable);
        }
        throw new IllegalStateException("No playable music address");
    }

    private static JSONObject lyric(String id) throws Exception {
        if (!id.matches("[0-9]{1,20}")) throw new IllegalArgumentException("Invalid song ID");
        JSONObject payload = new JSONObject();
        payload.put("id", id);
        payload.put("cp", "false");
        payload.put("tv", "0");
        payload.put("lv", "0");
        payload.put("rv", "0");
        payload.put("kv", "0");
        payload.put("yv", "0");
        payload.put("ytv", "0");
        payload.put("yrv", "0");
        JSONObject raw = eapi("/eapi/song/lyric", payload);
        JSONObject lrc = raw.optJSONObject("lrc");
        JSONObject translated = raw.optJSONObject("tlyric");
        JSONObject data = new JSONObject();
        data.put("lrc", lrc == null ? "" : lrc.optString("lyric"));
        data.put("tlyric", translated == null ? "" : translated.optString("lyric"));
        return ok(data);
    }

    private static JSONObject ok(Object data) throws Exception {
        JSONObject result = new JSONObject();
        result.put("code", 200);
        result.put("data", data);
        return result;
    }

    private static JSONObject eapi(String endpoint, JSONObject payload) throws Exception {
        JSONObject header = new JSONObject();
        header.put("os", "pc");
        header.put("appver", "");
        header.put("osver", "");
        header.put("deviceId", "pyncm!");
        header.put("requestId", String.valueOf(ThreadLocalRandom.current().nextInt(20000000, 30000001)));
        payload.put("header", header.toString());
        String path = endpoint.replace("/eapi/", "/api/");
        String body = payload.toString();
        String digest = hex(MessageDigest.getInstance("MD5").digest(("nobody" + path + "use" + body + "md5forencrypt").getBytes(StandardCharsets.UTF_8)));
        String value = path + DELIMITER + body + DELIMITER + digest;
        Cipher cipher = Cipher.getInstance("AES/ECB/PKCS5Padding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(AES_KEY, "AES"));
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] form = ("params=" + hex(encrypted)).getBytes(StandardCharsets.US_ASCII);

        HttpURLConnection connection = (HttpURLConnection) new URL(HOST + endpoint).openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(12000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("User-Agent", UA);
        connection.setRequestProperty("Cookie", "MUSIC_U=;os=pc;appver=8.9.75;");
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
        connection.setFixedLengthStreamingMode(form.length);
        try {
            try (OutputStream out = connection.getOutputStream()) { out.write(form); }
            return readJson(connection);
        } finally { connection.disconnect(); }
    }

    private static JSONObject readJson(HttpURLConnection connection) throws Exception {
        if (connection.getResponseCode() != 200)
            throw new IllegalStateException("Music service HTTP " + connection.getResponseCode());
        try (InputStream in = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = in.read(buffer)) != -1) {
                if (bytes.size() + n > 2_000_000) throw new IllegalStateException("Music response too large");
                bytes.write(buffer, 0, n);
            }
            return new JSONObject(bytes.toString("UTF-8"));
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) result.append(String.format(Locale.US, "%02x", b & 0xff));
        return result.toString();
    }
}
