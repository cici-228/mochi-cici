package com.mochi.remote;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Metadata-only Android adaptation of jiuhunwl/short_videos (MIT): Bilibili's
 * view endpoint and Douyin's public share-page router data. No video URL is
 * requested, stored, or played. Other supported share pages use public HTML
 * metadata when the platform supplies it.
 */
final class ShortVideoMetadata {
    private static final String USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
            + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
    private static final Pattern BVID = Pattern.compile("(?i)/video/(BV[0-9A-Za-z]{10})");
    private static final Pattern DOUYIN_ID = Pattern.compile("/(?:video|note|share/video)/([0-9]{10,25})");
    private static final Pattern META_TAG = Pattern.compile("<meta\\b[^>]*>", Pattern.CASE_INSENSITIVE);
    private static final Pattern ATTRIBUTE = Pattern.compile("([\\w:-]+)\\s*=\\s*([\"'])(.*?)\\2", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern ROUTER_DATA = Pattern.compile("window\\._ROUTER_DATA\\s*=\\s*(\\{.*?\\})\\s*;?\\s*</script", Pattern.DOTALL);
    private static final Pattern JSON_LD = Pattern.compile("<script[^>]*type=[\"']application/ld\\+json[\"'][^>]*>(.*?)</script>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern JSON_NAME = Pattern.compile("\"name\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
    private static final Pattern JSON_DURATION = Pattern.compile("\"duration\"\\s*:\\s*\"?([^\",}\\s]+)");

    private ShortVideoMetadata() {}

    static JSONObject resolve(String rawUrl) throws Exception {
        if (rawUrl == null || rawUrl.length() > 2048) throw new IllegalArgumentException("Invalid video share URL");
        URL original = normalizeShareUrl(new URL(rawUrl.trim()));
        URL page = followRedirects(original);
        String host = page.getHost().toLowerCase(Locale.ROOT);
        JSONObject result = null;
        if (host.equals("bilibili.com") || host.endsWith(".bilibili.com")) {
            try { result = bilibili(page); } catch (Exception ignored) {}
        } else if (host.equals("douyin.com") || host.endsWith(".douyin.com") || host.equals("iesdouyin.com") || host.endsWith(".iesdouyin.com")) {
            try { result = douyin(page); } catch (Exception ignored) {}
        }
        if (result == null || result.optString("title").isEmpty() || result.optDouble("durationSec", 0) <= 0) {
            try {
                JSONObject fallback = htmlMetadata(requestText(page, 3_000_000));
                if (result == null) result = fallback;
                else {
                    if (result.optString("title").isEmpty()) result.put("title", fallback.optString("title"));
                    if (result.optDouble("durationSec", 0) <= 0) result.put("durationSec", fallback.optDouble("durationSec", 0));
                }
            } catch (Exception ignored) {}
        }
        return result == null ? empty() : result;
    }

    private static JSONObject bilibili(URL page) throws Exception {
        Matcher match = BVID.matcher(page.getPath());
        if (!match.find()) return empty();
        String bvid = match.group(1);
        URL api = validated(new URL("https://api.bilibili.com/x/web-interface/view?bvid=" + bvid));
        JSONObject raw = new JSONObject(requestText(api, 1_500_000));
        if (raw.optInt("code", -1) != 0) return empty();
        JSONObject data = raw.optJSONObject("data");
        if (data == null) return empty();
        String title = data.optString("title", "");
        double duration = data.optDouble("duration", 0);
        int pageNumber = queryPageNumber(page.getQuery());
        JSONArray pages = data.optJSONArray("pages");
        if (pageNumber > 0 && pages != null && pageNumber <= pages.length()) {
            JSONObject part = pages.optJSONObject(pageNumber - 1);
            if (part != null) {
                String partName = part.optString("part", "").trim();
                if (!partName.isEmpty() && !partName.equals(title)) title += " · " + partName;
                duration = part.optDouble("duration", duration);
            }
        }
        return metadata(title, duration);
    }

    private static int queryPageNumber(String query) {
        if (query == null) return 0;
        Matcher match = Pattern.compile("(?:^|&)p=([0-9]{1,3})(?:&|$)").matcher(query);
        return match.find() ? Integer.parseInt(match.group(1)) : 0;
    }

    private static JSONObject douyin(URL page) throws Exception {
        Matcher id = DOUYIN_ID.matcher(page.getPath());
        if (!id.find()) {
            id = Pattern.compile("(?:^|&)modal_id=([0-9]{10,25})(?:&|$)").matcher(String.valueOf(page.getQuery()));
            if (!id.find()) return empty();
        }
        URL share = validated(new URL("https://www.iesdouyin.com/share/video/" + id.group(1)));
        return parseDouyinRouter(requestText(share, 3_000_000));
    }

    static JSONObject parseDouyinRouter(String html) throws Exception {
        Matcher match = ROUTER_DATA.matcher(html);
        if (!match.find()) return empty();
        JSONObject root = new JSONObject(match.group(1));
        JSONObject loader = root.optJSONObject("loaderData");
        JSONObject item = null;
        if (loader != null) {
            // Douyin changes the route key between page versions; the source
            // parser looks for any video_* loader entry with item_list data.
            java.util.Iterator<String> keys = loader.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (!key.startsWith("video_")) continue;
                JSONObject page = loader.optJSONObject(key);
                JSONObject response = page == null ? null : page.optJSONObject("videoInfoRes");
                JSONArray items = response == null ? null : response.optJSONArray("item_list");
                item = items == null ? null : items.optJSONObject(0);
                if (item != null) break;
            }
        }
        if (item == null) return empty();
        JSONObject video = item.optJSONObject("video");
        double rawDuration = video == null ? 0 : video.optDouble("duration", 0);
        double seconds = rawDuration >= 1000 ? rawDuration / 1000 : rawDuration;
        return metadata(item.optString("desc", ""), seconds);
    }

    static JSONObject htmlMetadata(String html) throws Exception {
        String title = "";
        double duration = 0;
        Matcher tags = META_TAG.matcher(html);
        while (tags.find()) {
            String tag = tags.group();
            String key = "", value = "";
            Matcher attrs = ATTRIBUTE.matcher(tag);
            while (attrs.find()) {
                String attr = attrs.group(1).toLowerCase(Locale.ROOT);
                if (attr.equals("property") || attr.equals("name")) key = attrs.group(3).toLowerCase(Locale.ROOT);
                else if (attr.equals("content")) value = decodeHtml(attrs.group(3)).trim();
            }
            if (title.isEmpty() && (key.equals("og:title") || key.equals("twitter:title"))) title = value;
            if (duration <= 0 && (key.equals("video:duration") || key.equals("og:video:duration") || key.equals("duration")))
                duration = durationSeconds(value);
        }
        Matcher scripts = JSON_LD.matcher(html);
        while (scripts.find() && (title.isEmpty() || duration <= 0)) {
            String json = scripts.group(1);
            if (!json.contains("VideoObject") && !json.contains("Movie") && !json.contains("Episode")) continue;
            if (title.isEmpty()) {
                Matcher name = JSON_NAME.matcher(json);
                if (name.find()) {
                    try { title = new JSONArray("[\"" + name.group(1) + "\"]").getString(0); }
                    catch (Exception ignored) { title = decodeHtml(name.group(1)); }
                }
            }
            if (duration <= 0) {
                Matcher value = JSON_DURATION.matcher(json);
                if (value.find()) duration = durationSeconds(value.group(1));
            }
        }
        return metadata(title, duration);
    }

    private static double durationSeconds(String raw) {
        if (raw == null) return 0;
        String value = raw.trim();
        try { return Math.max(0, Math.min(604800, Duration.parse(value).toMillis() / 1000.0)); }
        catch (Exception ignored) {}
        if (value.matches("[0-9]{1,3}:[0-9]{2}(?::[0-9]{2})?")) {
            String[] parts = value.split(":");
            double seconds = 0;
            for (String part : parts) seconds = seconds * 60 + Integer.parseInt(part);
            return seconds;
        }
        try {
            double number = Double.parseDouble(value);
            return Double.isFinite(number) && number > 0 && number <= 604800 ? number : 0;
        } catch (Exception ignored) { return 0; }
    }

    private static JSONObject metadata(String rawTitle, double seconds) throws Exception {
        String title = decodeHtml(rawTitle == null ? "" : rawTitle).replaceAll("[\\s\\u00a0]+", " ").trim();
        title = title.replaceFirst("\\s*[-_｜|]\\s*(哔哩哔哩|bilibili|抖音|小红书|快手)\\s*$", "").trim();
        if (title.length() > 120) title = title.substring(0, 120);
        JSONObject result = new JSONObject();
        result.put("title", title);
        result.put("durationSec", Double.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 604800) : 0);
        return result;
    }

    private static JSONObject empty() throws Exception { return metadata("", 0); }

    private static String decodeHtml(String text) {
        String value = text.replace("&amp;", "&").replace("&quot;", "\"")
                .replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ");
        Matcher codes = Pattern.compile("&#(x[0-9a-fA-F]+|[0-9]+);").matcher(value);
        StringBuffer output = new StringBuffer();
        while (codes.find()) {
            try {
                String number = codes.group(1);
                int code = number.startsWith("x") ? Integer.parseInt(number.substring(1), 16) : Integer.parseInt(number);
                codes.appendReplacement(output, Matcher.quoteReplacement(new String(Character.toChars(code))));
            } catch (Exception ignored) { codes.appendReplacement(output, Matcher.quoteReplacement(codes.group())); }
        }
        codes.appendTail(output);
        return output.toString();
    }

    private static URL validated(URL url) throws Exception {
        String host = url.getHost().toLowerCase(Locale.ROOT);
        if (!url.getProtocol().equalsIgnoreCase("https") || url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)
                || url.toString().length() > 2048 || !allowedHost(host)) throw new IllegalArgumentException("Unsupported video share URL");
        return url;
    }

    private static URL normalizeShareUrl(URL url) throws Exception {
        if (url.getProtocol().equalsIgnoreCase("http") && url.getUserInfo() == null
                && (url.getPort() == -1 || url.getPort() == 80) && allowedHost(url.getHost().toLowerCase(Locale.ROOT))) {
            url = new URL("https", url.getHost(), url.getFile());
        }
        return validated(url);
    }

    private static boolean allowedHost(String host) {
        String[] domains = { "b23.tv", "bilibili.com", "douyin.com", "iesdouyin.com", "kuaishou.com",
                "xiaohongshu.com", "xhslink.com", "weibo.com", "weibo.cn", "t.cn", "toutiao.com", "ixigua.com" };
        for (String domain : domains) if (host.equals(domain) || host.endsWith("." + domain)) return true;
        return false;
    }

    private static URL followRedirects(URL input) throws Exception {
        URL current = input;
        for (int i = 0; i < 5; i++) {
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("User-Agent", USER_AGENT);
            try {
                int status = connection.getResponseCode();
                if (status < 300 || status >= 400) return current;
                String location = connection.getHeaderField("Location");
                if (location == null || location.isEmpty()) return current;
                current = validated(new URL(current, location));
            } finally { connection.disconnect(); }
        }
        return current;
    }

    private static String requestText(URL url, int maxBytes) throws Exception {
        URL current = url;
        for (int i = 0; i < 5; i++) {
            HttpURLConnection connection = (HttpURLConnection) validated(current).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(12000);
            connection.setRequestProperty("User-Agent", USER_AGENT);
            connection.setRequestProperty("Accept", "text/html,application/json");
            try {
                int status = connection.getResponseCode();
                if (status >= 300 && status < 400) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new IllegalStateException("Video redirect missing location");
                    current = validated(new URL(current, location));
                    continue;
                }
                if (status != 200) throw new IllegalStateException("Video metadata HTTP " + status);
                try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int n;
                    while ((n = in.read(buffer)) != -1) {
                        if (out.size() + n > maxBytes) throw new IllegalStateException("Video metadata response too large");
                        out.write(buffer, 0, n);
                    }
                    return out.toString(StandardCharsets.UTF_8.name());
                }
            } finally { connection.disconnect(); }
        }
        throw new IllegalStateException("Too many video redirects");
    }
}
