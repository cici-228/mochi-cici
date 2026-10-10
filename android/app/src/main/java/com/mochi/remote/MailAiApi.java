package com.mochi.remote;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class MailAiApi {
    private static final int MAX_RESPONSE_BYTES = 1024 * 1024;

    private MailAiApi() {}

    static JSONObject interpret(String endpoint, String model, String apiKey,
                                String systemPrompt, String userPrompt) throws Exception {
        if (endpoint == null || endpoint.length() > 2048 || model == null || model.isEmpty()
                || model.length() > 160 || apiKey == null || apiKey.isEmpty()
                || apiKey.length() > 4096 || apiKey.contains("\n") || apiKey.contains("\r")
                || systemPrompt == null || systemPrompt.length() > 10000
                || userPrompt == null || userPrompt.length() > 50000)
            throw new IllegalArgumentException("接口设置或信件内容无效");

        URL url = new URL(endpoint);
        if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getHost().isEmpty()
                || url.getUserInfo() != null || url.getRef() != null)
            throw new IllegalArgumentException("请使用 HTTPS 接口地址");

        JSONObject body = new JSONObject();
        body.put("model", model);
        body.put("stream", false);
        JSONArray messages = new JSONArray();
        messages.put(new JSONObject().put("role", "system").put("content", systemPrompt));
        messages.put(new JSONObject().put("role", "user").put("content", userPrompt));
        body.put("messages", messages);

        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        // Long letters can take several minutes to interpret; keep this below the UI deadline.
        connection.setReadTimeout(300000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        connection.setRequestProperty("Authorization", "Bearer " + apiKey);
        connection.setDoOutput(true);
        try {
            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = connection.getOutputStream()) { out.write(payload); }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) throw new IllegalArgumentException("接口发生重定向，请填写最终 HTTPS 地址");
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String raw = input == null ? "" : readLimited(input);
            JSONObject response;
            try { response = new JSONObject(raw); }
            catch (Exception error) { throw new IllegalArgumentException("接口返回的不是有效 JSON"); }
            if (status >= 400) {
                JSONObject apiError = response.optJSONObject("error");
                String detail = apiError == null ? "" : apiError.optString("message", "");
                throw new IllegalArgumentException(detail.isEmpty() ? "接口返回错误 " + status : detail);
            }
            JSONArray choices = response.optJSONArray("choices");
            JSONObject first = choices == null ? null : choices.optJSONObject(0);
            JSONObject message = first == null ? null : first.optJSONObject("message");
            Object content = message == null ? null : message.opt("content");
            String text = content instanceof String ? ((String) content).trim() : "";
            if (text.isEmpty() && content instanceof JSONArray) {
                StringBuilder joined = new StringBuilder();
                JSONArray parts = (JSONArray) content;
                for (int i = 0; i < parts.length(); i++) {
                    JSONObject part = parts.optJSONObject(i);
                    if (part != null && !part.optString("text", "").isEmpty())
                        joined.append(part.optString("text")).append('\n');
                }
                text = joined.toString().trim();
            }
            if (text.isEmpty()) throw new IllegalArgumentException("接口没有返回解读内容");
            return new JSONObject().put("ok", true).put("content", text);
        } finally {
            connection.disconnect();
        }
    }

    private static String readLimited(InputStream input) throws Exception {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = in.read(buffer)) != -1) {
                if (out.size() + count > MAX_RESPONSE_BYTES)
                    throw new IllegalArgumentException("接口响应过大");
                out.write(buffer, 0, count);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}
