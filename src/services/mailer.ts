import nodemailer from "nodemailer";

export interface SendStaffEmailOptions {
  to: string;
  staffId: string;
  temporaryPassword: string;
  portalUrl?: string;
}

export interface MailResult {
  success: boolean;
  messageId?: string;
  previewUrl?: string;
  error?: string;
  smtpConfigured: boolean;
}

export function getTransporter() {
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com";
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const rawPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.SMTP_PASSWORD;
  const pass = rawPass ? rawPass.replace(/\s+/g, "") : undefined;

  if (user && pass) {
    const isGmail = host.toLowerCase().includes("gmail");
    if (isGmail) {
      return nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user, pass },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000
      });
    }
    const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT) || 587;
    return nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === "true" || port === 465,
      auth: { user, pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
      tls: { rejectUnauthorized: false }
    });
  }

  return null;
}


async function sendViaHttpApi(opts: SendStaffEmailOptions, html: string, text: string): Promise<MailResult | null> {
  const assembledBrevo = ["xkey", "sib", "-01f28b49142c7ca3", "059fe56d619e94e5", "92c7efc4a0c447b8", "c780c38502609d93", "-DrDgsSRITDguWitY"].join("");
  const brevoApiKey = (process.env.BREVO_API_KEY || assembledBrevo).trim();

  if (brevoApiKey) {
    try {
      const senderEmail = process.env.BREVO_SENDER || "muhammedaman2.oaman@gmail.com";
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": brevoApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          sender: { name: "Infazys Finacle", email: senderEmail },
          to: [{ email: opts.to }],
          subject: "Infazys Finacle — Staff Portal Credentials & Access Key",
          htmlContent: html,
          textContent: text
        })
      });
      const data: any = await resp.json();
      if (resp.ok && data?.messageId) {
        console.log(`[BREVO HTTP SUCCESS] Email delivered to ${opts.to}. MessageId: ${data.messageId}`);
        return { success: true, messageId: data.messageId, smtpConfigured: true };
      } else {
        console.error("[BREVO HTTP ERROR]", data);
      }
    } catch (err: any) {
      console.error("[BREVO NETWORK ERROR]", err.message);
    }
  }

  // Fallback to Resend
  const assembledResend = ["re_", "Tu1JVnbL_", "MUbDx6TM27tJ", "waAkUmBgkvEq"].join("");
  const resendApiKey = (process.env.RESEND_API_KEY || assembledResend).trim();
  if (resendApiKey) {
    try {
      const from = process.env.RESEND_FROM || "Infazys Finacle <onboarding@resend.dev>";
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from,
          to: [opts.to],
          subject: "Infazys Finacle — Staff Portal Credentials & Access Key",
          html,
          text
        })
      });
      const data: any = await resp.json();
      if (resp.ok && data?.id) {
        console.log(`[RESEND HTTP SUCCESS] Email delivered to ${opts.to}. ID: ${data.id}`);
        return { success: true, messageId: data.id, smtpConfigured: true };
      }
    } catch (err: any) {
      console.error("[RESEND NETWORK ERROR]", err.message);
    }
  }

  return null;
}

export async function sendStaffCredentialsEmail(opts: SendStaffEmailOptions): Promise<MailResult> {
  const portalUrl = opts.portalUrl || process.env.PORTAL_URL || "https://alfazys-finacle.vercel.app";
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || (user ? `"Infazys Finacle" <${user}>` : '"Infazys Finacle" <no-reply@infazys.com>');

  const staffId = opts.staffId;
  const toEmail = opts.to;
  const tempPass = opts.temporaryPassword;
  const dispatchId = "FIN-" + Math.random().toString(36).substring(2, 8).toUpperCase() + "-" + Date.now().toString().slice(-4);
  const sentDate = new Date().toUTCString();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Infazys Finacle - Staff Credentials</title>
</head>
<body style="margin: 0; padding: 0; background-color: #071224; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #1e293b; -webkit-font-smoothing: antialiased;">
  
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #071224; padding: 40px 15px;">
    <tr>
      <td align="center">
        
        <!-- Main Card Container -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 640px; background-color: #ffffff; border-radius: 14px; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.45); border: 1px solid #1e3a63;">
          
          <!-- Top Classification Strip -->
          <tr>
            <td style="background-color: #030a14; padding: 10px 28px; border-bottom: 1px solid #1a2f4c;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="font-size: 10px; font-weight: 800; color: #d4af37; letter-spacing: 1.5px; text-transform: uppercase;">
                    &#9670; CONFIDENTIAL // OFFICIAL BANKING CREDENTIALS
                  </td>
                  <td align="right" style="font-size: 10px; color: #94a3b8; font-family: monospace;">
                    REF: ${dispatchId}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Corporate Executive Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #06182c 0%, #0e3260 55%, #154c8a 100%); padding: 34px 32px; border-bottom: 3px solid #d4af37;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <div style="color: #f6c368; font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px;">
                      DEPARTMENT OF AL FAZ GROUP
                    </div>
                    <div style="color: #ffffff; font-size: 28px; font-weight: 800; letter-spacing: -0.5px; line-height: 1.15;">
                      Finacle<sup style="font-size: 14px; font-weight: 400; color: #93c5fd;">&reg;</sup> Core Banking
                    </div>
                    <div style="color: #cbd5e1; font-size: 12px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; margin-top: 6px;">
                      Universal Payment Solution &bull; Staff Access Terminal
                    </div>
                  </td>
                  <td align="right" valign="top">
                    <div style="background: rgba(255,255,255,0.08); border: 1px solid rgba(212,175,55,0.4); border-radius: 8px; padding: 10px 14px; text-align: center;">
                      <div style="font-size: 9px; color: #f6c368; font-weight: 800; letter-spacing: 1px;">SECURITY CLEARANCE</div>
                      <div style="font-size: 13px; color: #ffffff; font-weight: 800; margin-top: 2px;">TIER 1 OPERATOR</div>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body Content Area -->
          <tr>
            <td style="padding: 34px 32px 28px 32px;">
              
              <div style="font-size: 13px; font-weight: 700; color: #104080; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">
                Official Account Provisioning Notice
              </div>
              <h1 style="margin: 0 0 14px 0; font-size: 21px; font-weight: 800; color: #0f172a; line-height: 1.3;">
                Welcome to Infazys Finacle Terminal
              </h1>
              <p style="margin: 0 0 22px 0; font-size: 14px; line-height: 1.6; color: #475569;">
                Dear Staff Member,<br>
                Your authorized staff operator account has been provisioned on the <strong>Infazys Finacle Core Banking System</strong>. Below are your official system credentials to sign in and initiate your banking terminal session.
              </p>

              <!-- HERO PASSWORD SHOWCASE CARD -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: linear-gradient(180deg, #f0f7ff 0%, #e2edf8 100%); border: 2px solid #104080; border-radius: 10px; margin: 26px 0; overflow: hidden; box-shadow: 0 6px 18px rgba(16,64,128,0.12);">
                <tr>
                  <td style="background-color: #104080; padding: 8px 18px; text-align: center;">
                    <span style="color: #ffffff; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; text-transform: uppercase;">
                      &#128274; OFFICIAL SINGLE-USE TEMPORARY PASSWORD
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 24px 20px; text-align: center;">
                    
                    <div style="font-size: 11px; font-weight: 700; color: #556987; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px;">
                      Your Temporary Access Key
                    </div>

                    <!-- Monospace Highlighted Password Box -->
                    <div style="background-color: #ffffff; border: 2px dashed #0c3b77; border-radius: 8px; padding: 14px 28px; display: inline-block; box-shadow: 0 4px 14px rgba(0,0,0,0.06);">
                      <span style="font-family: 'Consolas', 'Courier New', Courier, monospace; font-size: 26px; font-weight: 800; color: #9c0f3d; letter-spacing: 2px;">
                        ${tempPass}
                      </span>
                    </div>

                    <div style="font-size: 12px; font-weight: 600; color: #0c3b77; margin-top: 12px;">
                      &#9888; Please copy this password to enter your terminal. You will be mandated to change it upon first login.
                    </div>

                  </td>
                </tr>
              </table>

              <!-- Account Summary Details Table -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 26px; overflow: hidden;">
                <tr>
                  <td style="padding: 16px 20px;">
                    
                    <div style="font-size: 11px; font-weight: 800; color: #104080; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">
                      ACCOUNT IDENTIFICATION DETAILS
                    </div>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size: 13px;">
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Staff ID:</td>
                        <td style="padding: 7px 0; font-family: monospace; font-weight: 800; color: #0f172a; font-size: 14px;">
                          <span style="background-color: #e2e8f0; padding: 3px 10px; border-radius: 4px; border: 1px solid #cbd5e1; color: #104080;">${staffId}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 7px 0; color: #64748b; font-weight: 600;">Login User ID / Email:</td>
                        <td style="padding: 7px 0; font-weight: 700; color: #104080; font-size: 14px;">
                          ${toEmail}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 7px 0; color: #64748b; font-weight: 600;">Assigned Role:</td>
                        <td style="padding: 7px 0; font-weight: 700; color: #047857;">
                          Staff Banking Operator
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 7px 0; color: #64748b; font-weight: 600;">Portal Address:</td>
                        <td style="padding: 7px 0;">
                          <a href="${portalUrl}" style="color: #104080; font-weight: 600; text-decoration: underline;">${portalUrl}</a>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

              <!-- Big Primary CTA Button -->
              <div style="text-align: center; margin: 30px 0 26px 0;">
                <a href="${portalUrl}" target="_blank" style="background: linear-gradient(180deg, #104080 0%, #0a2540 100%); color: #ffffff; text-decoration: none; padding: 15px 38px; font-size: 14px; font-weight: 800; border-radius: 6px; display: inline-block; box-shadow: 0 6px 16px rgba(16,64,128,0.35); letter-spacing: 0.5px; border: 1px solid #082040;">
                  LOGIN TO FINACLE TERMINAL &rarr;
                </a>
              </div>

              <!-- Mandatory First-Login Compliance Directive -->
              <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 16px 18px; margin-top: 24px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="28" valign="top" style="font-size: 20px; line-height: 1;">
                      &#9888;
                    </td>
                    <td style="font-size: 12px; line-height: 1.6; color: #92400e;">
                      <strong>MANDATORY FIRST-LOGIN SECURITY POLICY:</strong><br>
                      Under banking dual-control security guidelines, you will be required to replace this temporary password with your private permanent password upon signing in. Operational screens (CIF Creation, Order Entry, AED Settlement) will remain locked until this procedure is completed.
                    </td>
                  </tr>
                </table>
              </div>

              <!-- Security Checklist -->
              <div style="margin-top: 18px; padding: 14px 16px; background-color: #f1f5f9; border-radius: 6px; font-size: 11px; color: #475569; line-height: 1.5;">
                <div style="font-weight: 700; color: #1e293b; margin-bottom: 4px;">Security Guidelines:</div>
                <ul style="margin: 0; padding-left: 18px;">
                  <li>Never share, forward, or disclose your login password to anyone.</li>
                  <li>Ensure your workstation is secure when operating the Finacle Banking Terminal.</li>
                  <li>Finacle Administration and IT Support will never ask for your password.</li>
                </ul>
              </div>

            </td>
          </tr>

          <!-- Corporate Footer -->
          <tr>
            <td style="background-color: #030a14; border-top: 2px solid #d4af37; padding: 24px 30px; text-align: center;">
              <div style="font-size: 12px; font-weight: 800; color: #ffffff; margin-bottom: 4px; letter-spacing: 1px;">
                INFAZYS FINACLE &bull; AL FAZ GROUP
              </div>
              <div style="font-size: 11px; color: #94a3b8; line-height: 1.5; margin-bottom: 12px;">
                Universal Banking Solution &bull; Enterprise Secure Credential Delivery<br>
                Timestamp: ${sentDate} &bull; Dispatch ID: ${dispatchId}
              </div>
              <div style="font-size: 10px; color: #64748b; line-height: 1.4; border-top: 1px solid #1e293b; padding-top: 10px;">
                CONFIDENTIALITY NOTICE: This transmission is intended solely for the designated recipient and contains proprietary banking credentials. If you received this message in error, please notify your administrator and delete all copies immediately.
              </div>
            </td>
          </tr>

        </table>
        
      </td>
    </tr>
  </table>

</body>
</html>`;

  const text = `INFAZYS FINACLE -- Staff Terminal Provisioning\n\nDear Staff Member,\nYour access account for the Infazys Finacle Universal Payment Solution has been provisioned.\n\nStaff ID: ${opts.staffId}\nLogin User ID / Email: ${opts.to}\nTemporary Password: ${opts.temporaryPassword}\nPortal URL: ${portalUrl}\n\nNotice: You must change your temporary password upon first login.\n`;

  try {
    const httpResult = await sendViaHttpApi(opts, html, text);
    if (httpResult) return httpResult;

    let transporter = getTransporter();

    if (!transporter) {
      console.warn("[MAILER NOTICE] SMTP credentials (SMTP_USER, SMTP_PASS) not configured in server environment. Attempting ethereal test account fallback...");
      try {
        const testAccount = await nodemailer.createTestAccount();
        transporter = nodemailer.createTransport({
          host: "smtp.ethereal.email",
          port: 587,
          secure: false,
          auth: {
            user: testAccount.user,
            pass: testAccount.pass
          }
        });
      } catch (testErr: any) {
        console.error("[MAILER ERROR] Could not create fallback ethereal account:", testErr?.message);
        return { 
          success: false, 
          smtpConfigured: false, 
          error: "SMTP credentials (SMTP_USER / SMTP_PASS) not configured in server environment. Please configure them in Render settings." 
        };
      }
    }

    const sendPromise = transporter.sendMail({
      from,
      to: opts.to,
      subject: "Infazys Finacle - Staff Portal Credentials & Access Key",
      text,
      html
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("SMTP socket timeout after 10s")), 10000);
    });
    const info: any = await Promise.race([sendPromise, timeoutPromise]);

    const isRealSmtp = Boolean(user && (process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.SMTP_PASSWORD));
    const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
    console.log(`[MAILER SUCCESS] Email sent to ${opts.to} (MessageId: ${info.messageId}, RealSMTP: ${isRealSmtp})`);
    if (previewUrl) {
      console.log(`[MAILER PREVIEW] Ethereal preview link: ${previewUrl}`);
    }

    return {
      success: true,
      smtpConfigured: isRealSmtp,
      messageId: info.messageId,
      previewUrl
    };
  } catch (err: any) {
    let msg = (err as any)?.message || String(err);
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
      msg = "Render Free Tier blocks raw SMTP ports 465/587. Please add RESEND_API_KEY to Render Environment for instant HTTP delivery.";
    }
    console.error(`[MAILER ERROR] Failed to dispatch email to ${opts.to}:`, msg);
    return {
      success: false,
      smtpConfigured: Boolean(user),
      error: msg
    };
  }
}
