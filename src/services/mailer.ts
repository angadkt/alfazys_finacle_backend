export interface SendStaffEmailOptions {
  to: string;
  staffId: string;
  temporaryPassword: string;
  portalUrl?: string;
  fullName?: string;
  staffCode?: string;
  loginUsername?: string;
}

export interface MailResult {
  success: boolean;
  messageId?: string;
  previewUrl?: string;
  error?: string;
  smtpConfigured: boolean;
  status?: "queued" | "delivered" | "failed";
}

/**
 * Backward-compatible stub in case external scripts import getTransporter.
 */
export function getTransporter() {
  return null;
}

/**
 * Dispatches an email via the deployed Google Apps Script Web App.
 */
async function sendViaGoogleAppsScript(
  opts: SendStaffEmailOptions,
  subject: string,
  text: string,
  html: string
): Promise<MailResult> {
  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL?.trim();
  const apiSecret = process.env.API_SECRET?.trim();

  if (!scriptUrl || !apiSecret) {
    const errorMsg = "Missing GOOGLE_APPS_SCRIPT_URL or API_SECRET in environment";
    console.error(`[GOOGLE APPS SCRIPT CONFIG ERROR for ${opts.to}]:`, errorMsg);
    return {
      success: false,
      error: errorMsg,
      smtpConfigured: false,
      status: "failed"
    };
  }

  try {
    const payload = {
      apiKey: apiSecret,
      to: opts.to,
      subject,
      message: text,
      htmlBody: html
    };

    const resp = await fetch(scriptUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(15000)
    });

    const responseText = await resp.text();
    let responseData: any = null;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = null;
    }

    if (!resp.ok) {
      const errReason = responseData?.error || responseData?.message || responseText || `HTTP ${resp.status}`;
      console.error(`[GOOGLE APPS SCRIPT HTTP ERROR ${resp.status} for ${opts.to}]:`, errReason);
      return {
        success: false,
        error: `Google Apps Script HTTP error (${resp.status}): ${errReason}`,
        smtpConfigured: true,
        status: "failed"
      };
    }

    // Check application-level status from Google Apps Script
    if (responseData) {
      if (responseData.status === "error" || responseData.success === false || responseData.error) {
        const errReason = responseData.message || responseData.error || "Execution failed in Google Apps Script";
        console.error(`[GOOGLE APPS SCRIPT REJECTED for ${opts.to}]:`, errReason);
        return {
          success: false,
          error: `Google Apps Script rejected delivery: ${errReason}`,
          smtpConfigured: true,
          status: "failed"
        };
      }
    } else if (responseText && /error|unauthorized|exception|failed/i.test(responseText)) {
      console.error(`[GOOGLE APPS SCRIPT REJECTED for ${opts.to}]:`, responseText);
      return {
        success: false,
        error: `Google Apps Script error: ${responseText}`,
        smtpConfigured: true,
        status: "failed"
      };
    }

    const messageId = responseData?.messageId || responseData?.id || `gas-${Date.now()}`;
    console.log(`[GOOGLE APPS SCRIPT SUCCESS] Email delivered to ${opts.to}. MessageId: ${messageId}`);
    return {
      success: true,
      messageId,
      smtpConfigured: true,
      status: "delivered"
    };
  } catch (err: any) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    const errMsg = isTimeout
      ? "Request to Google Apps Script timed out after 15 seconds"
      : (err?.message || "Network error");
    console.error(`[GOOGLE APPS SCRIPT NETWORK ERROR for ${opts.to}]:`, errMsg);
    return {
      success: false,
      error: errMsg,
      smtpConfigured: true,
      status: "failed"
    };
  }
}

export interface StaffEmailDispatchParams {
  toEmail: string;
  fullName: string;
  staffCode: string;
  loginUsername: string;
  temporaryPassword: string;
  portalUrl?: string;
}

export function generateStaffEmailHtml(params: StaffEmailDispatchParams): { html: string; text: string } {
  const { toEmail, fullName, staffCode, temporaryPassword } = params;
  const loginUserId = toEmail;
  const portalUrl = params.portalUrl || 'https://alfazys-finacle.vercel.app';
  const dispatchId = 'FIN-' + Math.random().toString(36).substring(2, 8).toUpperCase() + '-' + Date.now().toString().slice(-4);
  const sentDate = new Date().toUTCString();

  const text = `INFAZYS FINACLE - STAFF ACCOUNT PROVISIONED\n\n` +
    `Dear ${fullName},\n` +
    `Your authorized staff operator account has been provisioned on the Infazys Finacle Banking Core.\n\n` +
    `OFFICIAL LOGIN CREDENTIALS:\n` +
    `Login User ID: ${loginUserId}\n` +
    `Temporary Password: ${temporaryPassword}\n` +
    `Staff Code: ${staffCode}\n` +
    `Registered Email: ${toEmail}\n\n` +
    `Portal Address: ${portalUrl}\n\n` +
    `MANDATORY: You will be mandated to change your temporary password upon your first login.\n`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Infazys Finacle - Staff Credentials</title>
</head>
<body style="margin: 0; padding: 0; background-color: #071224; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; -webkit-font-smoothing: antialiased;">
  
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #071224; padding: 35px 12px;">
    <tr>
      <td align="center">
        
        <!-- Main Card Container -->
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 640px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 25px 50px rgba(0, 0, 0, 0.45); border: 1px solid #1e3a63;">
          
          <!-- Top Classification Strip -->
          <tr>
            <td style="background-color: #030a14; padding: 10px 24px; border-bottom: 1px solid #1a2f4c;">
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
            <td style="background: linear-gradient(135deg, #06182c 0%, #0e3260 55%, #154c8a 100%); padding: 30px 28px; border-bottom: 3px solid #d4af37;">
              <div style="color: #f6c368; font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 6px;">
                DEPARTMENT OF AL FAZ GROUP
              </div>
              <div style="color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; line-height: 1.2;">
                Finacle<sup style="font-size: 13px; font-weight: 400; color: #93c5fd;">&reg;</sup> Core Banking
              </div>
              <div style="color: #cbd5e1; font-size: 12px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; margin-top: 5px;">
                Universal Payment Solution &bull; Staff Access Terminal
              </div>
            </td>
          </tr>

          <!-- Body Content Area -->
          <tr>
            <td style="padding: 28px 24px 20px 24px;">
              
              <h1 style="margin: 0 0 10px 0; font-size: 19px; font-weight: 700; color: #0f172a; line-height: 1.3;">
                Operator Account Successfully Provisioned
              </h1>
              <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
                Dear <strong>${fullName}</strong>,<br>
                Your authorized staff operator account has been created on the <strong>Infazys Finacle Banking Core</strong>. Below are your official system credentials to sign in and initiate your terminal session.
              </p>

              <!-- HERO CREDENTIALS SHOWCASE BOX (DUAL BOX FOR LOGIN USER ID & PASSWORD) -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: linear-gradient(180deg, #f0f7ff 0%, #e2edf8 100%); border: 2px solid #104080; border-radius: 10px; margin: 24px 0; overflow: hidden; box-shadow: 0 8px 20px rgba(16,64,128,0.12);">
                <tr>
                  <td style="background: linear-gradient(90deg, #0a2540 0%, #104080 100%); padding: 10px 18px; text-align: center;">
                    <span style="color: #ffffff; font-size: 11px; font-weight: 800; letter-spacing: 1.8px; text-transform: uppercase;">
                      &#128274; OFFICIAL TERMINAL LOGIN CREDENTIALS
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 22px 18px;">
                    
                    <!-- 2-COLUMN CREDENTIAL DISPLAY -->
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <!-- Left Box: LOGIN USER ID -->
                        <td width="48%" valign="top" style="background-color: #ffffff; border: 2px solid #104080; border-radius: 8px; padding: 16px 12px; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                          <div style="font-size: 11px; font-weight: 800; color: #104080; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px;">
                            &#128100; LOGIN USER ID
                          </div>
                          <div style="background-color: #f0f6ff; border: 1.5px solid #bcd2e8; border-radius: 6px; padding: 10px 8px; margin: 4px 0 10px 0;">
                            <span style="font-family: 'Consolas', 'Courier New', Courier, monospace; font-size: 18px; font-weight: 800; color: #104080; letter-spacing: 0.5px; word-break: break-all; display: inline-block;">
                              ${loginUserId}
                            </span>
                          </div>
                          <div style="font-size: 11px; color: #475569; font-weight: 600;">
                            Enter this in &ldquo;User ID&rdquo; field
                          </div>
                        </td>

                        <td width="4%">&nbsp;</td>

                        <!-- Right Box: TEMPORARY PASSWORD -->
                        <td width="48%" valign="top" style="background-color: #ffffff; border: 2px solid #9c0f3d; border-radius: 8px; padding: 16px 12px; text-align: center; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
                          <div style="font-size: 11px; font-weight: 800; color: #9c0f3d; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px;">
                            &#128273; TEMPORARY PASSWORD
                          </div>
                          <div style="background-color: #fff1f2; border: 1.5px dashed #f43f5e; border-radius: 6px; padding: 10px 8px; margin: 4px 0 10px 0;">
                            <span style="font-family: 'Consolas', 'Courier New', Courier, monospace; font-size: 21px; font-weight: 800; color: #9c0f3d; letter-spacing: 1px; word-break: break-all; display: inline-block;">
                              ${temporaryPassword}
                            </span>
                          </div>
                          <div style="font-size: 11px; color: #475569; font-weight: 600;">
                            Mandatory 1st login update
                          </div>
                        </td>
                      </tr>
                    </table>

                    <div style="font-size: 12px; font-weight: 600; color: #0c3b77; margin-top: 14px; text-align: center;">
                      &#9888; Copy the <strong>Login User ID</strong> and <strong>Temporary Password</strong> above to enter your terminal.
                    </div>

                  </td>
                </tr>
              </table>

              <!-- Account Summary Details Table -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 24px; overflow: hidden;">
                <tr>
                  <td style="padding: 16px 20px;">
                    
                    <div style="font-size: 11px; font-weight: 800; color: #104080; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 12px; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px;">
                      ACCOUNT IDENTIFICATION DETAILS
                    </div>

                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size: 13px;">
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Staff Name:</td>
                        <td style="padding: 7px 0; font-weight: 700; color: #0f172a; font-size: 14px;">
                          ${fullName}
                        </td>
                      </tr>
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Staff Code / ID:</td>
                        <td style="padding: 7px 0; font-family: monospace; font-weight: 800; color: #0f172a; font-size: 14px;">
                          <span style="background-color: #e2e8f0; padding: 3px 10px; border-radius: 4px; border: 1px solid #cbd5e1; color: #104080;">${staffCode}</span>
                        </td>
                      </tr>
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Login User ID:</td>
                        <td style="padding: 7px 0; font-family: monospace; font-weight: 800; color: #104080; font-size: 15px;">
                          <span style="background-color: #e0edff; padding: 3px 10px; border-radius: 4px; border: 1px solid #90b8e8; color: #0b3c75; word-break: break-all;">${loginUserId}</span>
                        </td>
                      </tr>
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Registered Email:</td>
                        <td style="padding: 7px 0; font-weight: 600; color: #475569; font-size: 13px;">
                          ${toEmail}
                        </td>
                      </tr>
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Assigned Role:</td>
                        <td style="padding: 7px 0; font-weight: 700; color: #047857;">
                          Staff Banking Operator
                        </td>
                      </tr>
                      <tr>
                        <td width="160" style="padding: 7px 0; color: #64748b; font-weight: 600;">Portal Address:</td>
                        <td style="padding: 7px 0;">
                          <a href="${portalUrl}" style="color: #104080; font-weight: 600; text-decoration: underline;">${portalUrl}</a>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

              <!-- Big Primary CTA Button -->
              <div style="text-align: center; margin: 26px 0 22px 0;">
                <a href="${portalUrl}" target="_blank" style="background: linear-gradient(180deg, #104080 0%, #0a2540 100%); color: #ffffff; text-decoration: none; padding: 14px 36px; font-size: 14px; font-weight: 800; border-radius: 6px; display: inline-block; box-shadow: 0 6px 16px rgba(16,64,128,0.35); letter-spacing: 0.5px; border: 1px solid #082040;">
                  LOGIN TO FINACLE TERMINAL &rarr;
                </a>
              </div>

              <!-- Mandatory First-Login Compliance Directive -->
              <div style="background-color: #fffbeb; border: 1px solid #fef3c7; border-left: 4px solid #f59e0b; border-radius: 6px; padding: 14px 16px; margin-top: 20px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td width="26" valign="top" style="font-size: 18px; line-height: 1;">
                      &#9888;
                    </td>
                    <td style="font-size: 12px; line-height: 1.6; color: #92400e;">
                      <strong>MANDATORY FIRST-LOGIN SECURITY POLICY:</strong><br>
                      Under banking dual-control security guidelines, you will be required to replace this temporary password with your private permanent password upon signing in. Operational screens (CIF Creation, Order Entry, AED Settlement) will remain locked until this procedure is completed.
                    </td>
                  </tr>
                </table>
              </div>

            </td>
          </tr>

          <!-- Corporate Footer -->
          <tr>
            <td style="background-color: #030a14; border-top: 2px solid #d4af37; padding: 22px 26px; text-align: center;">
              <div style="font-size: 12px; font-weight: 800; color: #ffffff; margin-bottom: 4px; letter-spacing: 1px;">
                INFAZYS FINACLE &bull; AL FAZ GROUP
              </div>
              <div style="font-size: 11px; color: #94a3b8; line-height: 1.5; margin-bottom: 8px;">
                Universal Banking Solution &bull; Enterprise Secure Credential Delivery<br>
                Timestamp: ${sentDate} &bull; Dispatch ID: ${dispatchId}
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { html, text };
}

export async function sendStaffCredentialsEmail(opts: SendStaffEmailOptions): Promise<MailResult> {
  const portalUrl = opts.portalUrl || process.env.PORTAL_URL || "https://alfazys-finacle.vercel.app";
  const fullName = opts.fullName || opts.to.split('@')[0].toUpperCase();
  const staffCode = opts.staffCode || opts.staffId;
  const loginUsername = opts.to;
  const subject = "Infazys Finacle — Staff Portal Credentials & Access Key";

  const { html, text } = generateStaffEmailHtml({
    toEmail: opts.to,
    fullName,
    staffCode,
    loginUsername,
    temporaryPassword: opts.temporaryPassword,
    portalUrl
  });

  return sendViaGoogleAppsScript(opts, subject, text, html);
}
