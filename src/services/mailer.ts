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
  <title>Infazys Finacle Staff Provisioning</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b1528; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; -webkit-font-smoothing: antialiased;">
  
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #0b1528; padding: 40px 15px;">
    <tr>
      <td align="center">
        
        <!-- Main Container -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 620px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.35); border: 1px solid #1e3a63;">
          
          <!-- Top Classification Strip -->
          <tr>
            <td style="background-color: #06101e; padding: 9px 24px; border-bottom: 1px solid #1a2f4c;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="font-size: 10px; font-weight: 700; color: #d4af37; letter-spacing: 1.5px; text-transform: uppercase;">
                    &#9670; CONFIDENTIAL // INTERNAL BANKING CREDENTIALS
                  </td>
                  <td align="right" style="font-size: 10px; color: #94a3b8; font-family: monospace;">
                    REF: ${dispatchId}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Primary Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #0a2540 0%, #104080 60%, #17549c 100%); padding: 32px 30px; border-bottom: 3px solid #d4af37;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <div style="color: #f1b34c; font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px;">
                      Department Of AL Faz Group
                    </div>
                    <div style="color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; line-height: 1.2;">
                      Finacle<sup style="font-size: 13px; font-weight: 400; color: #93c5fd;">&reg;</sup> Core Banking
                    </div>
                    <div style="color: #cbd5e1; font-size: 12px; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; margin-top: 4px;">
                      Universal Payment Solution &bull; Staff Access Terminal
                    </div>
                  </td>
                  <td align="right" valign="top" style="display: none;">
                    <div style="background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 8px 12px; text-align: center;">
                      <div style="font-size: 10px; color: #93c5fd; font-weight: 700;">SECURITY TIER</div>
                      <div style="font-size: 13px; color: #ffffff; font-weight: 800;">TIER 1</div>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body Content Area -->
          <tr>
            <td style="padding: 34px 32px 28px 32px;">
              
              <!-- Greeting & Announcement -->
              <h1 style="margin: 0 0 14px 0; font-size: 19px; font-weight: 700; color: #0f172a; line-height: 1.3;">
                Operator Account Successfully Provisioned
              </h1>
              <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
                Dear Staff Member,<br>
                An authorized administrative session has provisioned your user account on the <strong>Infazys Finacle Universal Banking Core</strong>. Your terminal profile has been established with module-level access permissions.
              </p>

              <!-- Credentials Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; margin: 24px 0; overflow: hidden; border-left: 4px solid #104080;">
                <tr>
                  <td style="padding: 20px 22px;">
                    
                    <div style="font-size: 11px; font-weight: 800; color: #104080; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 14px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">
                      AUTHENTICATION CREDENTIALS
                    </div>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size: 13px;">
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Staff ID Code:</td>
                        <td style="padding: 7px 0; font-family: monospace; font-weight: 700; color: #0f172a; font-size: 14px;">
                          <span style="background-color: #e2e8f0; padding: 2px 8px; border-radius: 4px; border: 1px solid #cbd5e1;">${staffId}</span>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 7px 0; color: #64748b; font-weight: 600;">Login User ID / Email:</td>
                        <td style="padding: 7px 0; font-weight: 700; color: #104080; font-size: 14px;">
                          ${toEmail}
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 10px 0; color: #64748b; font-weight: 600;" valign="top">Temporary Access Key:</td>
                        <td style="padding: 10px 0;">
                          <div style="background-color: #fef2f2; border: 1px solid #fecaca; border-left: 3px solid #dc2626; padding: 8px 14px; border-radius: 4px; display: inline-block;">
                            <span style="font-family: 'Courier New', Courier, monospace; font-size: 17px; font-weight: 800; color: #991b1b; letter-spacing: 1.5px;">
                              ${tempPass}
                            </span>
                          </div>
                          <div style="font-size: 11px; color: #dc2626; font-weight: 600; margin-top: 4px;">
                            &#9888; Single-use temporary access key
                          </div>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

              <!-- Action CTA Button -->
              <div style="text-align: center; margin: 30px 0 26px 0;">
                <a href="${portalUrl}" target="_blank" style="background: linear-gradient(180deg, #104080 0%, #0a2540 100%); color: #ffffff; text-decoration: none; padding: 14px 34px; font-size: 14px; font-weight: 700; border-radius: 6px; display: inline-block; box-shadow: 0 4px 12px rgba(16,64,128,0.3); letter-spacing: 0.5px;">
                  ACCESS FINACLE TERMINAL &rarr;
                </a>
                <div style="font-size: 11px; color: #64748b; margin-top: 8px;">
                  Portal Address: <a href="${portalUrl}" style="color: #104080; font-weight: 600; text-decoration: underline;">${portalUrl}</a>
                </div>
              </div>

              <!-- Important Security Compliance Box -->
              <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 16px 18px; margin-top: 24px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="26" valign="top" style="font-size: 18px; line-height: 1;">
                      &#128274;
                    </td>
                    <td style="font-size: 12px; line-height: 1.55; color: #92400e;">
                      <strong>MANDATORY FIRST-LOGIN SECURITY POLICY:</strong><br>
                      In accordance with banking dual-control security standards, you must change this temporary password immediately upon your initial sign-in. Banking operational screens (CIF Creation, Order Entry, AED Settlement) will remain restricted until a permanent confidential password has been set.
                    </td>
                  </tr>
                </table>
              </div>

              <!-- Security Checklist -->
              <div style="margin-top: 20px; padding: 14px 16px; background-color: #f1f5f9; border-radius: 6px; font-size: 12px; color: #475569; line-height: 1.5;">
                <div style="font-weight: 700; color: #1e293b; margin-bottom: 4px;">Security Guidelines:</div>
                <ul style="margin: 0; padding-left: 18px;">
                  <li>Never share or forward your login credentials with anyone.</li>
                  <li>Ensure you are connected to an authorized network before logging in.</li>
                  <li>Finacle Administration will never request your password via phone or message.</li>
                </ul>
              </div>

            </td>
          </tr>

          <!-- Corporate Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 22px 30px; text-align: center;">
              <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">
                INFAZYS FINACLE &bull; AL FAZ GROUP
              </div>
              <div style="font-size: 11px; color: #64748b; line-height: 1.5; margin-bottom: 12px;">
                Automated Transaction &amp; Core Banking System &bull; Enterprise Secure Delivery<br>
                Timestamp: ${sentDate} &bull; Dispatch ID: ${dispatchId}
              </div>
              <div style="font-size: 10px; color: #94a3b8; line-height: 1.4; border-top: 1px solid #e2e8f0; padding-top: 10px;">
                CONFIDENTIALITY NOTICE: This transmission is intended solely for the addressee and contains proprietary banking information. If you received this transmission in error, please discard immediately and notify the system administrator.
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
    const msg = (err as any)?.message || String(err);
    console.error(`[MAILER ERROR] Failed to dispatch email to ${opts.to}:`, msg);
    return {
      success: false,
      smtpConfigured: Boolean(user),
      error: msg
    };
  }
}
