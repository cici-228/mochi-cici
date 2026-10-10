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
import java.security.SecureRandom;
import java.util.Locale;

/** Small Java port of Mei's title/artist/duration matching and QQ/Kuwo/Migu fallback flow.
 * The providers only return URLs they can actually read; a NetEase account is never sent to them.
 */
final class MeiFallbackResolver {
    private static final String QQ = "https://u.y.qq.com/cgi-bin/musicu.fcg";
    private static final SecureRandom RANDOM = new SecureRandom();

    static JSONObject resolve(JSONObject input) throws Exception {
        String title = input.optString("name").trim();
        String artist = input.optString("artist").trim();
        long duration = Math.max(0, input.optLong("duration"));
        if (title.isEmpty() || title.length() > 160 || artist.length() > 160) return new JSONObject();
        JSONObject found = qq(title, artist, duration);
        if (found == null) found = kuwo(title, artist, duration);
        if (found == null) found = migu(title, artist, duration);
        return found == null ? new JSONObject() : found;
    }

    private static JSONObject kuwo(String title, String artist, long duration) {
        try {
            String query = title + (artist.isEmpty() ? "" : " " + artist);
            String search = "https://search.kuwo.cn/r.s?correct=1&vipver=1&stype=comprehensive"
                    + "&encoding=utf8&rformat=json&mobi=1&show_copyright_off=1&searchapi=6&all=" + enc(query);
            JSONObject result = jsonGet(search);
            JSONArray content = result.optJSONArray("content");
            JSONObject music = content == null ? null : content.optJSONObject(1);
            JSONObject page = music == null ? null : music.optJSONObject("musicpage");
            JSONArray songs = page == null ? null : page.optJSONArray("abslist");
            if (songs == null) return null;
            for (int i = 0; i < Math.min(5, songs.length()); i++) {
                JSONObject song = songs.optJSONObject(i);
                if (song == null) continue;
                String id = song.optString("MUSICRID").replaceFirst("^MUSIC_", "");
                if (!id.matches("[0-9]+") || !matches(title, artist, duration,
                        song.optString("SONGNAME"), song.optString("ARTIST"), song.optLong("DURATION") * 1000)) continue;
                try {
                    String endpoint = "https://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3"
                            + "&response=url&rid=MUSIC_" + id;
                    String url = new String(read(endpoint, null, false), StandardCharsets.UTF_8).trim();
                    if (probe(url, duration)) return response(url, "kuwo", duration);
                } catch (Exception ignored) { /* 下一首候选。 */ }
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static JSONObject qq(String title, String artist, long duration) {
        try {
            String query = title + (artist.isEmpty() ? "" : " " + artist);
            JSONObject params = new JSONObject().put("query", query).put("search_type", 0)
                    .put("page_num", 1).put("num_per_page", 5).put("highlight", 0)
                    .put("nqc_flag", 0).put("page_id", 1).put("grp", 1);
            JSONObject comm = new JSONObject().put("ct", 11).put("cv", "1003006")
                    .put("v", "1003006").put("os_ver", "15").put("phonetype", "24122RKC7C")
                    .put("tmeAppID", "qqmusiclight").put("nettype", "NETWORK_WIFI").put("udid", "0");
            JSONObject call = new JSONObject().put("method", "DoSearchForQQMusicLite")
                    .put("module", "music.search.SearchCgiService").put("param", params);
            JSONObject result = jsonPost(QQ, new JSONObject().put("comm", comm).put("request", call));
            JSONArray songs = pathArray(result, "request", "data", "body", "item_song");
            if (songs == null || songs.length() == 0) {
                JSONObject desktop = new JSONObject().put("search", new JSONObject()
                        .put("method", "DoSearchForQQMusicDesktop")
                        .put("module", "music.search.SearchCgiService")
                        .put("param", new JSONObject().put("num_per_page", 5).put("page_num", 1)
                                .put("query", query).put("search_type", 0)));
                result = jsonGet(QQ + "?data=" + enc(desktop.toString()));
                songs = pathArray(result, "search", "data", "body", "song", "list");
            }
            if (songs == null) return null;
            for (int i = 0; i < Math.min(5, songs.length()); i++) {
                JSONObject song = songs.optJSONObject(i);
                if (song == null) continue;
                String candidateTitle = song.optString("title", song.optString("name"));
                String candidateArtist = artistNames(song.optJSONArray("singer"));
                long candidateDuration = song.optLong("interval") * 1000;
                if (!matches(title, artist, duration, candidateTitle, candidateArtist, candidateDuration)) continue;
                String mid = song.optString("mid");
                if (mid.isEmpty()) continue;
                for (String format : new String[] { "M500" + mid + ".mp3", "" }) {
                  try {
                    JSONObject vkeyParams = new JSONObject().put("guid", String.valueOf(RANDOM.nextInt(10_000_000)))
                            .put("loginflag", 1).put("songmid", new JSONArray().put(mid))
                            .put("songtype", new JSONArray().put(0)).put("uin", "0").put("platform", "20");
                    if (!format.isEmpty()) vkeyParams.put("filename", new JSONArray().put(format));
                    JSONObject vkeyCall = new JSONObject().put("module", "vkey.GetVkeyServer")
                            .put("method", "CgiGetVkey").put("param", vkeyParams);
                    JSONObject answer = jsonPost(QQ, new JSONObject().put("req_0", vkeyCall));
                    JSONObject data = pathObject(answer, "req_0", "data");
                    if (data == null) continue;
                    JSONArray info = data.optJSONArray("midurlinfo");
                    JSONArray hosts = data.optJSONArray("sip");
                    JSONObject first = info == null ? null : info.optJSONObject(0);
                    String path = first == null ? "" : first.optString("purl");
                    if (path.isEmpty()) continue;
                    String url = path.startsWith("http") ? path :
                            (hosts == null || hosts.length() == 0 ? "" : hosts.optString(0)) + path;
                    if (probe(url, duration)) return response(url, "qq", duration);
                  } catch (Exception ignored) { /* 下一种音质仍可能可用。 */ }
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static JSONObject migu(String title, String artist, long duration) {
        try {
            String query = title + (artist.isEmpty() ? "" : " " + artist);
            String search = "https://c.musicapp.migu.cn/v1.0/content/search_all.do?text=" + enc(query)
                    + "&pageNo=1&pageSize=5&isCopyright=1&sort=1&searchSwitch="
                    + enc("{\"song\":1,\"album\":0,\"singer\":0,\"tagSong\":1,\"mvSong\":0,\"bestShow\":1}");
            JSONObject result = jsonGet(search);
            JSONArray songs = pathArray(result, "songResultData", "result");
            if (songs == null) return null;
            for (int i = 0; i < Math.min(5, songs.length()); i++) {
                JSONObject song = songs.optJSONObject(i);
                if (song == null) continue;
                String candidateArtist = artistNames(song.optJSONArray("singers"));
                if (!matches(title, artist, duration, song.optString("name"), candidateArtist, 0)) continue;
                String contentId = song.optString("contentId");
                String copyrightId = song.optString("copyrightId");
                if (contentId.isEmpty() || copyrightId.isEmpty()) continue;
                for (String tone : new String[] { "HQ", "PQ" }) {
                  try {
                    String endpoint = "https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4?contentId="
                            + enc(contentId) + "&copyrightId=" + enc(copyrightId)
                            + "&resourceType=2&netType=01&toneFlag=" + tone
                            + "&scene=&lowerQualityContentId=" + enc(contentId);
                    byte[] payload = read(endpoint, null, false);
                    JSONObject answer = new JSONObject(decodeMigu(payload));
                    JSONObject data = answer.optJSONObject("data");
                    if (data == null || !tone.equals(data.optString("audioFormatType"))) continue;
                    String url = data.optString("url");
                    if (url.startsWith("//")) url = "https:" + url;
                    JSONObject detail = data.optJSONObject("song");
                    long actualDuration = detail == null ? 0 : detail.optLong("duration") * 1000;
                    if (duration > 0 && actualDuration > 0 && Math.abs(duration - actualDuration) > 10000) continue;
                    if (probe(url, duration)) return response(url, "migu", actualDuration > 0 ? actualDuration : duration);
                  } catch (Exception ignored) { /* 降到下一档音质。 */ }
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static String decodeMigu(byte[] raw) {
        if (raw.length < 4 || (raw[0] & 255) != 0xab || (raw[1] & 255) != 0xcd || raw[2] != 1)
            return new String(raw, StandardCharsets.UTF_8);
        byte[] key = "Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP".getBytes(StandardCharsets.US_ASCII);
        int seed = raw[3] & 255;
        byte[] decoded = new byte[raw.length - 4];
        for (int i = 0; i < decoded.length; i++) decoded[i] =
                (byte) ((raw[i + 4] & 255) + seed - (key[i % key.length] & 255));
        return new String(decoded, StandardCharsets.UTF_8);
    }

    private static boolean matches(String title, String artist, long duration,
                                   String otherTitle, String otherArtist, long otherDuration) {
        if (!normalize(title).equals(normalize(otherTitle))) return false;
        if (!artist.isEmpty() && !otherArtist.isEmpty()) {
            boolean artistMatch = false;
            for (String part : otherArtist.split("[/、,&]")) {
                String candidate = normalize(part);
                for (String expected : artist.split("[/、,&]"))
                    if (!candidate.isEmpty() && candidate.equals(normalize(expected))) artistMatch = true;
            }
            if (!artistMatch) return false;
        }
        return duration <= 0 || otherDuration <= 0 || Math.abs(duration - otherDuration) <= 10000;
    }

    private static String normalize(String raw) {
        return raw.toLowerCase(Locale.ROOT).replaceAll("[\\s\\p{P}\\p{S}]+", "");
    }

    private static String artistNames(JSONArray array) {
        if (array == null) return "";
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < array.length(); i++) {
            JSONObject artist = array.optJSONObject(i);
            if (artist == null) continue;
            if (text.length() > 0) text.append('/');
            text.append(artist.optString("name"));
        }
        return text.toString();
    }

    private static JSONObject response(String url, String source, long duration) throws Exception {
        return new JSONObject().put("url", url).put("source", source).put("time", duration);
    }

    private static JSONObject pathObject(JSONObject root, String... keys) {
        JSONObject next = root;
        for (String key : keys) { next = next == null ? null : next.optJSONObject(key); }
        return next;
    }

    private static JSONArray pathArray(JSONObject root, String... keys) {
        if (keys.length == 0) return null;
        for (int i = 0; i < keys.length - 1; i++) root = root == null ? null : root.optJSONObject(keys[i]);
        return root == null ? null : root.optJSONArray(keys[keys.length - 1]);
    }

    private static String enc(String value) throws Exception { return URLEncoder.encode(value, "UTF-8"); }
    private static JSONObject jsonGet(String url) throws Exception { return new JSONObject(new String(read(url, null, false), StandardCharsets.UTF_8)); }
    private static JSONObject jsonPost(String url, JSONObject body) throws Exception {
        return new JSONObject(new String(read(url, body.toString(), true), StandardCharsets.UTF_8));
    }

    private static byte[] read(String url, String body, boolean post) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(7000);
        connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Safari/537.36");
        connection.setRequestProperty("Referer", url.contains("y.qq.com") ? "https://y.qq.com/" : "https://h5.nf.migu.cn/");
        connection.setRequestProperty("Accept", "application/json, text/plain, */*");
        if (url.contains("migu.cn")) {
            connection.setRequestProperty("Origin", "https://h5.nf.migu.cn");
            connection.setRequestProperty("ua", "Android_migu");
            connection.setRequestProperty("version", "6.8.8");
            connection.setRequestProperty("channel", "014021I");
            connection.setRequestProperty("subchannel", "014021I");
            connection.setRequestProperty("birth", "h5page");
            connection.setRequestProperty("signature", "1");
        }
        if (post) {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json;charset=UTF-8");
        }
        try {
            if (post) try (OutputStream out = connection.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            if (connection.getResponseCode() >= 400) throw new Exception("备用音源接口不可用");
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = in.read(buffer)) != -1) {
                    if (bytes.size() + count > 2 * 1024 * 1024) throw new Exception("备用音源响应过大");
                    bytes.write(buffer, 0, count);
                }
                return bytes.toByteArray();
            }
        } finally { connection.disconnect(); }
    }

    private static boolean probe(String url, long expectedDuration) {
        if (!url.startsWith("https://")) return false;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setRequestProperty("Range", "bytes=0-8191");
            connection.setRequestProperty("Accept-Encoding", "identity");
            int code = connection.getResponseCode();
            if (code != 200 && code != 206) return false;
            String type = connection.getContentType();
            if (type != null && (type.startsWith("text/html") || type.startsWith("application/json"))) return false;
            String range = connection.getHeaderField("Content-Range");
            long length = 0;
            if (range != null && range.contains("/")) try { length = Long.parseLong(range.substring(range.lastIndexOf('/') + 1)); } catch (Exception ignored) { }
            if (length <= 0 && code == 200) length = connection.getContentLengthLong();
            if (expectedDuration > 0 && length > 0 && length < expectedDuration * 4) return false;
            try (InputStream in = connection.getInputStream()) { return in.read() >= 0; }
        } catch (Exception ignored) { return false; }
        finally { if (connection != null) connection.disconnect(); }
    }
}
