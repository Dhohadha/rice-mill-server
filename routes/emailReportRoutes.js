const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/auth');
const UserSettings = require('../models/UserSettings');
const { processDailyEmailExport } = require('../services/emailService');

// 1. GET /api/email-reports/status -> Returns current settings
router.get('/status', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const settings = await UserSettings.findOne({ userEmail });

    res.json({
      isEmailReportEnabled: !!(settings && settings.isEmailReportEnabled),
      reportEmail: settings ? settings.reportEmail : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. POST /api/email-reports/save -> Save Email settings
router.post('/save', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { isEmailReportEnabled, reportEmail } = req.body;

    const settings = await UserSettings.findOneAndUpdate(
      { userEmail },
      { 
        $set: { 
          isEmailReportEnabled: !!isEmailReportEnabled, 
          reportEmail: reportEmail ? reportEmail.trim() : null 
        } 
      },
      { upsert: true, returnDocument: 'after' }
    );

    console.log(`✅ [Email Settings] Updated for ${userEmail}: enabled=${settings.isEmailReportEnabled}, email=${settings.reportEmail}`);
    res.json({ 
      success: true, 
      isEmailReportEnabled: settings.isEmailReportEnabled,
      reportEmail: settings.reportEmail 
    });
  } catch (err) {
    console.error('❌ Email Settings Save Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/email-reports/test-export -> Manual Trigger
router.post('/test-export', verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email;
    const { deviceId, date } = req.body;
    const targetDeviceId = deviceId || 'RICE_MILL_001';

    const targetDate = date ? new Date(date) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    targetDate.setHours(0, 0, 0, 0);

    // Call processDailyEmailExport with forceSend = true to bypass isEmailReportEnabled check
    const result = await processDailyEmailExport(userEmail, targetDate, true);

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('❌ Test Email Export Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
