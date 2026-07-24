const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const UserSettings = require('../models/UserSettings');
const User = require('../models/User');
const DailyUsage = require('../models/DailyUsage');
const reportService = require('./reportService');

/**
 * Send an email with attachments
 */
async function sendMail({ to, subject, html, attachments }) {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('⚠️ [SMTP] Environment variables not fully configured. Skipping mail dispatch.');
    return { success: false, reason: 'SMTP credentials missing in server .env' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  const mailOptions = {
    from: `"Rice Mill IoT Monitor" <${user}>`,
    to,
    subject,
    html,
    attachments
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`📧 [SMTP] Email sent successfully to ${to}: ${info.messageId}`);
  return { success: true, messageId: info.messageId };
}

/**
 * Main function: Generates reports and emails them to user
 */
async function processDailyEmailExport(userEmail, date, forceSend = false) {
  const settings = await UserSettings.findOne({ userEmail });
  
  if (!settings) {
    console.log(`⚠️ [Email Export] Skipped for ${userEmail}: No settings found.`);
    return { success: false, reason: 'UserSettings not found' };
  }

  if (!settings.isEmailReportEnabled && !forceSend) {
    console.log(`⚠️ [Email Export] Skipped for ${userEmail}: Email reports not enabled.`);
    return { success: false, reason: 'Email reports are disabled for this user' };
  }

  const targetEmail = settings.reportEmail && settings.reportEmail.trim().length > 0 
    ? settings.reportEmail.trim() 
    : userEmail;

  // Fetch user's assigned devices
  const user = await User.findOne({ email: userEmail });
  const deviceIds = (user && user.assignedDevices && user.assignedDevices.length > 0)
    ? user.assignedDevices
    : ['RICE_MILL_001', 'APFC_001', 'EMS_002'];

  const dateStr = date.toISOString().split('T')[0];
  console.log(`📊 Generating Collective Multi-Device PDF & Excel report for ${userEmail} (${deviceIds.length} devices) on ${dateStr}...`);

  // Gather daily summaries
  const deviceSummaries = [];
  for (const id of deviceIds) {
    const summary = await DailyUsage.findOne({ deviceId: id, date }) || {};
    deviceSummaries.push({
      deviceId: id,
      totalKWh: summary.totalKWh || 0,
      totalKVAh: summary.totalKVAh || 0,
      maxKW: summary.maxKW || 0,
      maxKVA: summary.maxKVA || 0,
      avgPF: summary.avgPF || 0
    });
  }

  // Generate Graph, PDF and Excel buffers
  const chartBuffer = await reportService.generateMultiDeviceGraph(deviceIds, date);
  const pdfBuffer = await reportService.generateMultiDevicePDFReport(deviceSummaries, dateStr, chartBuffer);
  const excelBuffer = await reportService.generateMultiDeviceExcelData(deviceIds, date);

  // Save reports locally in exports directory
  const exportDir = path.join(__dirname, '../exports');
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }

  // Safe file writer to avoid EBUSY locks
  const safeWriteFile = (filePath, buffer) => {
    try {
      fs.writeFileSync(filePath, buffer);
    } catch (err) {
      if (err.code === 'EBUSY') {
        const ext = path.extname(filePath);
        const base = path.basename(filePath, ext);
        const dir = path.dirname(filePath);
        const altPath = path.join(dir, `${base}_${Date.now()}${ext}`);
        console.log(`⚠️ File ${path.basename(filePath)} is locked. Saved as: ${path.basename(altPath)}`);
        fs.writeFileSync(altPath, buffer);
      } else {
        throw err;
      }
    }
  };

  const pdfPath = path.join(exportDir, `Collective_Energy_Report_${dateStr}.pdf`);
  const excelPath = path.join(exportDir, `Collective_Meter_Data_${dateStr}.xlsx`);
  safeWriteFile(pdfPath, pdfBuffer);
  safeWriteFile(excelPath, excelBuffer);

  // Prepare HTML Email Body
  const totalKWh = deviceSummaries.reduce((sum, d) => sum + (d.totalKWh || 0), 0);
  const totalKVAh = deviceSummaries.reduce((sum, d) => sum + (d.totalKVAh || 0), 0);
  const peakKW = Math.max(0, ...deviceSummaries.map(d => d.maxKW || 0));
  const validPfs = deviceSummaries.map(d => d.avgPF || 0).filter(pf => pf > 0);
  const plantAvgPF = validPfs.length > 0 ? validPfs.reduce((a, b) => a + b, 0) / validPfs.length : 0;

  let tableRowsHtml = '';
  deviceSummaries.forEach((d) => {
    tableRowsHtml += `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #0f172a; font-weight: 500;">${d.deviceId}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #334155; text-align: right;">${d.totalKWh.toFixed(1)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #334155; text-align: right;">${d.totalKVAh.toFixed(1)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #334155; text-align: right;">${d.maxKW.toFixed(2)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #334155; text-align: right;">${d.avgPF.toFixed(3)}</td>
      </tr>
    `;
  });

  const htmlEmail = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Rice Mill Daily Energy Report</title>
    </head>
    <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f1f5f9; color: #1e293b; margin: 0; padding: 20px;">
      <div style="background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 30px; max-width: 600px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
        
        <div style="background-color: #0f172a; padding: 20px; border-radius: 12px; text-align: center; color: #ffffff; margin-bottom: 25px;">
          <h2 style="margin: 0; font-size: 20px; letter-spacing: 0.5px; font-weight: 700;">DAILY ENERGY REPORT</h2>
          <p style="margin: 5px 0 0 0; color: #94a3b8; font-size: 12px;">Date: ${dateStr} | ${deviceIds.length} Devices</p>
        </div>

        <p style="font-size: 14px; line-height: 1.5; color: #334155;">Hello,</p>
        <p style="font-size: 14px; line-height: 1.5; color: #334155;">
          Here is your automated daily energy report. Below is a high-level summary of your energy usage across all monitoring nodes. Detailed PDF reports (with load curves) and raw logs (Excel spreadsheet) are attached to this email.
        </p>
        
        <h4 style="margin: 20px 0 10px 0; color: #0f172a; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Collective Plant Totals</h4>
        
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px;">
          <tr>
            <td style="width: 50%; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; text-align: center;">
              <div style="font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Total Energy (Active)</div>
              <div style="font-size: 18px; font-weight: 700; color: #0f172a;">${totalKWh.toFixed(1)} kWh</div>
            </td>
            <td style="width: 50%; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; text-align: center;">
              <div style="font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Apparent Energy</div>
              <div style="font-size: 18px; font-weight: 700; color: #0f172a;">${totalKVAh.toFixed(1)} kVAh</div>
            </td>
          </tr>
          <tr>
            <td style="width: 50%; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; text-align: center;">
              <div style="font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Peak Active Power</div>
              <div style="font-size: 18px; font-weight: 700; color: #0f172a;">${peakKW.toFixed(2)} kW</div>
            </td>
            <td style="width: 50%; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; text-align: center;">
              <div style="font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px;">Avg Power Factor</div>
              <div style="font-size: 18px; font-weight: 700; color: #0f172a;">${plantAvgPF.toFixed(3)}</div>
            </td>
          </tr>
        </table>

        <h4 style="margin: 20px 0 10px 0; color: #0f172a; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Device Breakdown</h4>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0;">
          <thead>
            <tr style="background-color: #1e293b; color: #ffffff;">
              <th style="padding: 10px; font-size: 11px; text-transform: uppercase; text-align: left; font-weight: 600;">Device ID</th>
              <th style="padding: 10px; font-size: 11px; text-transform: uppercase; text-align: right; font-weight: 600;">kWh</th>
              <th style="padding: 10px; font-size: 11px; text-transform: uppercase; text-align: right; font-weight: 600;">kVAh</th>
              <th style="padding: 10px; font-size: 11px; text-transform: uppercase; text-align: right; font-weight: 600;">Peak kW</th>
              <th style="padding: 10px; font-size: 11px; text-transform: uppercase; text-align: right; font-weight: 600;">Avg PF</th>
            </tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>

        <p style="font-size: 13px; line-height: 1.5; color: #64748b; margin-bottom: 25px;">
          For granular hourly data, load curve graphics, and raw logs, please review the attached PDF and Excel files.
        </p>

        <div style="font-size: 11px; text-align: center; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 15px; margin-top: 25px; line-height: 1.4;">
          This is an automated system notification. Please do not reply directly to this email.<br>
          © 2026 Rice Mill IoT Monitoring Services
        </div>

      </div>
    </body>
    </html>
  `;

  // Send Email with Attachments
  const emailResult = await sendMail({
    to: targetEmail,
    subject: `📋 Rice Mill Daily Energy Report [${dateStr}]`,
    html: htmlEmail,
    attachments: [
      {
        filename: `Collective_Energy_Report_${dateStr}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf'
      },
      {
        filename: `Collective_Meter_Data_${dateStr}.xlsx`,
        content: excelBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }
    ]
  });

  if (emailResult.success) {
    return {
      success: true,
      date: dateStr,
      deviceCount: deviceIds.length,
      recipient: targetEmail,
      message: `Daily report for ${deviceIds.length} devices successfully emailed to ${targetEmail}!`
    };
  } else {
    // Return local fallback info if SMTP not configured
    return {
      success: true,
      demoMode: true,
      date: dateStr,
      deviceCount: deviceIds.length,
      localPdfPath: pdfPath,
      localExcelPath: excelPath,
      message: `Daily report generated locally! (SMTP note: ${emailResult.reason}. Saved in server/exports/).`
    };
  }
}

module.exports = {
  processDailyEmailExport
};
