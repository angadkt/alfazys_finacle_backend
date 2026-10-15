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
}

function getTransporter() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = process.env.SMTP_SECURE === "true" || port === 465;
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.SMTP_PASSWORD;

  if (user && pass) {
    return nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: { rejectUnauthorized: false }
    });
  }

  return null;
}

export async function sendStaffCredentialsEmail(opts: SendStaffEmailOptions): Promise<MailResult> {
  const portalUrl = opts.portalUrl || process.env.PORTAL_URL || "https://alfazys-finacle.vercel.app";
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || (user ? `"Infazys Finacle" <${user}>` : '"Infazys Finacle" <no-reply@infazys.com>');

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 620px; border: 2px solid #104080; background: #ffffff; padding: 24px; color: #333; margin: 0 auto;">
      <div style="background: #104080; color: #ffffff; padding: 14px 18px; font-size: 17px; font-weight: bold; letter-spacing: 0.5px; border-radius: 2px;">
        INFAZYS FINACLE — Staff Terminal Provisioning
      </div>
      <div style="padding: 20px 8px;">
        <p style="font-size: 14px; margin-bottom: 14px; color: #222;">Dear Staff Member,</p>
        <p style="font-size: 13px; line-height: 1.6; color: #444;">
          Your access account for the <strong>Infazys Finacle Universal Payment Solution</strong> has been provisioned by the Administrator.
        </p>
        <div style="background: #f4f7fb; border: 1px solid #c9d7e8; border-left: 4px solid #104080; padding: 16px; margin: 20px 0; border-radius: 2px;">
          <table style="width: 100%; font-size: 13px; font-family: monospace; border-collapse: collapse;">
            <tr>
              <td style="font-weight: bold; width: 160px; padding: 6px 0; color: #555;">Staff ID:</td>
              <td style="color: #104080; font-weight: bold; font-size: 14px;">${opts.staffId}</td>
            </tr>
            <tr>
              <td style="font-weight: bold; padding: 6px 0; color: #555;">Login User ID / Email:</td>
              <td style="font-weight: bold; color: #222;">${opts.to}</td>
            </tr>
            <tr>
              <td style="font-weight: bold; padding: 6px 0; color: #555;">Temporary Password:</td>
              <td style="color: #9c0f3d; font-weight: bold; font-size: 16px; font-family: monospace; letter-spacing: 1px;">${opts.temporaryPassword}</td>
            </tr>
            <tr>
              <td style="font-weight: bold; padding: 6px 0; color: #555;">Portal URL:</td>
              <td><a href="${portalUrl}" style="color: #15549a; font-weight: bold; text-decoration: underline;">${portalUrl}</a></td>
            </tr>
          </table>
        </div>
        <div style="background: #fff3cd; border: 1px solid #ffeeba; color: #856404; padding: 12px 16px; font-size: 12px; font-weight: bold; margin-top: 14px; border-radius: 2px; line-height: 1.5;">
          ⚠ MANDATORY FIRST-LOGIN NOTICE: Upon your initial sign-in, the system will prompt you to replace this temporary password with your permanent password. Access to banking features will remain locked until this is completed.
        </div>
      </div>
      <div style="border-top: 1px solid #e2e8f0; margin-top: 20px; padding-top: 12px; font-size: 11px; color: #777; text-align: center;">
        Infazys Finacle Banking Core • Confidential Automated Notification • Do Not Reply
      </div>
    </div>
  `;

  const text = `INFAZYS FINACLE — Staff Terminal Provisioning\n\nDear Staff Member,\nYour access account for the Infazys Finacle Universal Payment Solution has been provisioned.\n\nStaff ID: ${opts.staffId}\nLogin User ID / Email: ${opts.to}\nTemporary Password: ${opts.temporaryPassword}\nPortal URL: ${portalUrl}\n\nNotice: You must change your temporary password upon first login.\n`;

  try {
    let transporter = getTransporter();

    if (!transporter) {
      console.warn("⚠️ SMTP credentials (SMTP_USER, SMTP_PASS) not set in .env. Creating test mailer...");
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
        console.error("Failed to create test email account:", (testErr as any)?.message);
        return { success: false, error: "SMTP credentials not configured" };
      }
    }

    const info = await transporter.sendMail({
      from,
      to: opts.to,
      subject: "Infazys Finacle — Staff Portal Credentials & Access Key",
      text,
      html
    });

    const previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
    console.log(`✅ Email dispatched to ${opts.to}. MessageId: ${info.messageId}`);
    if (previewUrl) {
      console.log(`📧 Preview URL: ${previewUrl}`);
    }

    return {
      success: true,
      messageId: info.messageId,
      previewUrl
    };
  } catch (err: any) {
    const msg = (err as any)?.message || String(err);
    console.error(`❌ Failed to dispatch email to ${opts.to}:`, msg);
    return {
      success: false,
      error: msg
    };
  }
}
