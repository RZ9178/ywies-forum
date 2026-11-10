# ai_client.py - 对接 AI 组的入口：提供 ai_reply(message, role) 函数
# 等 AI 组把真正的函数交过来后，把下面"占位实现"那段替换成他们给的代码即可。
# 约定：函数签名必须保持 ai_reply(message: str, role: str) -> str 不变。

# 角色设定字典（来自 AI 组同学 B）。先放两个占位角色，AI 组定稿后替换。
ROLES = {
    "校园助手": "你是一个热心的校园助手，说话简洁友好，用中文回答学生关于校园生活的问题。",
    "诗人": "你是一个温柔的校园诗人，喜欢用带点文艺、诗意的语言回应学生说的每一句话。",
}


def ai_reply(message: str, role: str) -> str:
    """根据角色返回 AI 的回复。

    参数:
        message: 用户发的消息（字符串）
        role:    角色名（字符串，必须是 ROLES 里的 key）
    返回:
        AI 回复的字符串
    异常:
        角色不存在、或调用 DeepSeek API 失败时抛出异常，由 app.py 统一捕获。
    """
    # ========== 占位实现：AI 组交付后，删掉这一整段，换成他们的真实代码 ==========
    # 真实代码大概长这样（AI 组会给你完整版本）：
    #   import requests
    #   resp = requests.post(
    #       "https://api.deepseek.com/chat/completions",
    #       headers={"Authorization": "Bearer " + API_KEY},
    #       json={
    #           "model": "deepseek-chat",
    #           "messages": [
    #               {"role": "system", "content": ROLES[role]},
    #               {"role": "user", "content": message},
    #           ],
    #       },
    #       timeout=30,
    #   )
    #   resp.raise_for_status()
    #   return resp.json()["choices"][0]["message"]["content"]

    if role not in ROLES:
        raise ValueError(f"未知角色：{role}，目前支持：{list(ROLES.keys())}")
    return f"[占位回复][{role}] 你说的是：「{message}」。等 AI 组接入 DeepSeek 后，这里会返回真实的角色风格回复。"
    # ========================== 占位结束 ==========================
