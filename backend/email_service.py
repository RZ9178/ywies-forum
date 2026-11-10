# email_service.py
# 邮件验证码发送服务
# 配置通过环境变量：
#   SMTP_HOST    例如 smtp.qq.com / smtp.gmail.com
#   SMTP_PORT    例如 465（SSL）
#   SMTP_USER    发件邮箱
#   SMTP_PASS    发件邮箱授权码/应用密码
# 没配置时走"测试模式"：验证码打印到终端，不真实发邮件（本地开发用）

import os
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header


def is_configured():
    return bool(os.getenv("SMTP_HOST") and os.getenv("SMTP_USER") and os.getenv("SMTP_PASS"))


def send_code(to_email: str, code: str) -> bool:
    """发送验证码邮件。返回 True 表示成功。"""
    if not is_configured():
        print(f"[邮件-测试模式] 给 {to_email} 的验证码是：{code}")
        return True

    host = os.getenv("SMTP_HOST")
    port = int(os.getenv("SMTP_PORT", "465"))
    user = os.getenv("SMTP_USER")
    password = os.getenv("SMTP_PASS")

    msg = MIMEMultipart()
    msg["From"] = Header(f"YWIES 论坛 <{user}>", "utf-8")
    msg["To"] = to_email
    msg["Subject"] = Header("YWIES 论坛 验证码", "utf-8")
    body = f"""
    <div style="font-family: sans-serif; padding: 24px; color: #222;">
      <h2>YWIES 论坛注册</h2>
      <p>你的验证码是：</p>
      <p style="font-size: 28px; font-weight: bold; color: #c6dd4e; letter-spacing: 4px;">{code}</p>
      <p>验证码 5 分钟内有效，请勿泄露给他人。</p>
    </div>
    """
    msg.attach(MIMEText(body, "html", "utf-8"))

    context = ssl.create_default_context()
    try:
        with smtplib.SMTP_SSL(host, port, context=context) as server:
            server.login(user, password)
            server.sendmail(user, to_email, msg.as_string())
        print(f"[邮件] 已发送验证码到 {to_email}")
        return True
    except Exception as e:
        print(f"[邮件] 发送失败：{e}")
        return False
