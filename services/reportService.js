const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const QuickChart = require('quickchart-js');
const MeterData = require('../models/MeterData');
const DailyUsage = require('../models/DailyUsage');

// Color palette for multiple devices in graphs & tables
const DEVICE_COLORS = ['#2563EB', '#16A34A', '#D97706', '#9333EA', '#DC2626', '#0891B2'];

/**
 * 1. Generate Combined Multi-Device 24-Hour Graph Image Buffer
 */
async function generateMultiDeviceGraph(deviceIds, date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const datasets = [];

  for (let idx = 0; idx < deviceIds.length; idx++) {
    const deviceId = deviceIds[idx];
    const color = DEVICE_COLORS[idx % DEVICE_COLORS.length];

    const rawData = await MeterData.find({
      deviceId,
      timestamp: { $gte: start, $lte: end }
    }).sort({ timestamp: 1 }).lean();

    const hourlyKva = Array.from({ length: 24 }, (_, hour) => {
      const pts = rawData.filter(d => new Date(d.timestamp).getHours() === hour);
      if (pts.length === 0) return 0;
      const avg = pts.reduce((acc, p) => acc + (p.KVA || 0), 0) / pts.length;
      return parseFloat(avg.toFixed(1));
    });

    datasets.push({
      label: `${deviceId} (KVA)`,
      data: hourlyKva,
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.3,
    });
  }

  const chart = new QuickChart();
  chart.setConfig({
    type: 'line',
    data: {
      labels: Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`),
      datasets: datasets
    },
    options: {
      title: { display: true, text: `24-Hour Multi-Device Load Curve`, fontSize: 16 },
      scales: {
        yAxes: [{ ticks: { beginAtZero: true }, scaleLabel: { display: true, labelString: 'Apparent Power (KVA)' } }],
        xAxes: [{ scaleLabel: { display: true, labelString: 'Hour of Day' } }]
      }
    }
  });

  chart.setWidth(650).setHeight(300);
  try {
    return await chart.toBinary();
  } catch (err) {
    console.error('⚠️ QuickChart multi-device graph rendering failed:', err.message);
    return null;
  }
}

/**
 * 2. Generate Multi-Device PDF Report Buffer (pdfkit)
 */
async function generateMultiDevicePDFReport(deviceSummaries, dateStr, chartBuffer) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // --- Header Title ---
    doc.rect(40, 40, 515, 50).fill('#0F172A');
    doc.fillColor('#FFFFFF').fontSize(18).text('RICE MILL MULTI-DEVICE DAILY ENERGY REPORT', 50, 50, { align: 'center' });
    const devListStr = deviceSummaries.map(d => d.deviceId).join(', ');
    doc.fontSize(8).fillColor('#94A3B8').text(`Devices: ${devListStr}   |   Date: ${dateStr}`, { align: 'center' });

    doc.moveDown(2.5);

    // --- Combined Plant Totals Card ---
    const totalKWh = deviceSummaries.reduce((sum, d) => sum + (d.totalKWh || 0), 0);
    const totalKVAh = deviceSummaries.reduce((sum, d) => sum + (d.totalKVAh || 0), 0);
    const peakKW = Math.max(0, ...deviceSummaries.map(d => d.maxKW || 0));
    const peakKVA = Math.max(0, ...deviceSummaries.map(d => d.maxKVA || 0));
    const validPfs = deviceSummaries.map(d => d.avgPF || 0).filter(pf => pf > 0);
    const plantAvgPF = validPfs.length > 0 ? validPfs.reduce((a, b) => a + b, 0) / validPfs.length : 0;

    const gridTop = 100;
    doc.rect(40, gridTop, 515, 60).fillAndStroke('#F8FAFC', '#CBD5E1');

    doc.fillColor('#1E293B').fontSize(11).text('COLLECTIVE PLANT TOTALS', 50, gridTop + 8);
    doc.moveTo(50, gridTop + 22).lineTo(545, gridTop + 22).strokeColor('#E2E8F0').stroke();

    doc.fontSize(9).fillColor('#334155');
    let line1Y = gridTop + 28;
    doc.text(`Total Energy: `, 50, line1Y, { continued: true }).fillColor('#0F172A').text(`${totalKWh.toFixed(1)} kWh`, { continued: true });
    doc.fillColor('#334155').text(`   |   Apparent: `, { continued: true }).fillColor('#0F172A').text(`${totalKVAh.toFixed(1)} kVAh`, { continued: true });
    doc.fillColor('#334155').text(`   |   Peak KW: `, { continued: true }).fillColor('#0F172A').text(`${peakKW.toFixed(2)} kW`, { continued: true });
    doc.fillColor('#334155').text(`   |   Avg PF: `, { continued: true }).fillColor('#0F172A').text(`${plantAvgPF.toFixed(3)}`);

    // --- Per-Device Breakdown Table ---
    const tableTop = 175;
    doc.fillColor('#1E293B').fontSize(12).text('Per-Device Energy Breakdown', 40, tableTop);

    let y = tableTop + 18;
    // Table Header Row
    doc.rect(40, y, 515, 20).fill('#1E293B');
    doc.fillColor('#FFFFFF').fontSize(8);
    doc.text('Device ID', 45, y + 5, { width: 110 });
    doc.text('Total KWh', 155, y + 5, { width: 80, align: 'right' });
    doc.text('Total KVAh', 240, y + 5, { width: 80, align: 'right' });
    doc.text('Peak KW', 325, y + 5, { width: 75, align: 'right' });
    doc.text('Peak KVA', 405, y + 5, { width: 75, align: 'right' });
    doc.text('Avg PF', 485, y + 5, { width: 65, align: 'right' });

    y += 20;

    // Table Data Rows
    deviceSummaries.forEach((d, i) => {
      const bgColor = i % 2 === 0 ? '#F8FAFC' : '#FFFFFF';
      doc.rect(40, y, 515, 18).fillAndStroke(bgColor, '#F1F5F9');

      doc.fillColor('#0F172A').fontSize(8);
      doc.text(d.deviceId, 45, y + 4, { width: 110 });
      doc.text((d.totalKWh || 0).toFixed(1), 155, y + 4, { width: 80, align: 'right' });
      doc.text((d.totalKVAh || 0).toFixed(1), 240, y + 4, { width: 80, align: 'right' });
      doc.text((d.maxKW || 0).toFixed(2), 325, y + 4, { width: 75, align: 'right' });
      doc.text((d.maxKVA || 0).toFixed(2), 405, y + 4, { width: 75, align: 'right' });
      doc.text((d.avgPF || 0).toFixed(3), 485, y + 4, { width: 65, align: 'right' });
      y += 18;
    });

    // Table Summary Total Row
    doc.rect(40, y, 515, 20).fill('#0F172A');
    doc.fillColor('#FFFFFF').fontSize(8);
    doc.text('COMBINED TOTAL', 45, y + 5, { width: 110 });
    doc.text(totalKWh.toFixed(1), 155, y + 5, { width: 80, align: 'right' });
    doc.text(totalKVAh.toFixed(1), 240, y + 5, { width: 80, align: 'right' });
    doc.text(peakKW.toFixed(2), 325, y + 5, { width: 75, align: 'right' });
    doc.text(peakKVA.toFixed(2), 405, y + 5, { width: 75, align: 'right' });
    doc.text(plantAvgPF.toFixed(3), 485, y + 5, { width: 65, align: 'right' });

    // --- Embedded 24-Hour Load Graph ---
    const graphTop = y + 35;
    doc.fillColor('#1E293B').fontSize(12).text('24-Hour Multi-Device Load Curve', 40, graphTop);
    
    if (chartBuffer && graphTop + 260 < 770) {
      doc.image(chartBuffer, 40, graphTop + 16, { fit: [515, 250], align: 'center' });
    }

    // --- Footer ---
    const footerY = 765;
    doc.moveTo(40, footerY).lineTo(555, footerY).strokeColor('#E2E8F0').stroke();
    doc.fontSize(8).fillColor('#64748B').text(
      `Rice Mill IoT Monitoring System • Multi-Device Report generated on ${new Date().toLocaleString()}`,
      40,
      footerY + 8,
      { align: 'center' }
    );

    doc.end();
  });
}

/**
 * 3. Generate Multi-Device Excel (.xlsx) Data Buffer (exceljs)
 */
async function generateMultiDeviceExcelData(deviceIds, date) {
  const workbook = new ExcelJS.Workbook();
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  // Tab 1: Collective Summary
  const sheet1 = workbook.addWorksheet('Collective Summary');
  sheet1.columns = [
    { header: 'Device ID', key: 'deviceId', width: 18 },
    { header: 'Total KWh', key: 'kwh', width: 15 },
    { header: 'Total KVAh', key: 'kvah', width: 15 },
    { header: 'Peak KW', key: 'maxKw', width: 15 },
    { header: 'Peak KVA', key: 'maxKva', width: 15 },
    { header: 'Avg PF', key: 'avgPf', width: 15 },
  ];

  sheet1.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  sheet1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } };

  let plantKWh = 0, plantKVAh = 0, plantMaxKW = 0, plantMaxKVA = 0, pfSum = 0;

  for (const deviceId of deviceIds) {
    const summary = await DailyUsage.findOne({ deviceId, date }) || {};
    const kwh = summary.totalKWh || 0;
    const kvah = summary.totalKVAh || 0;
    const maxKw = summary.maxKW || 0;
    const maxKva = summary.maxKVA || 0;
    const avgPf = summary.avgPF || 0;

    plantKWh += kwh;
    plantKVAh += kvah;
    if (maxKw > plantMaxKW) plantMaxKW = maxKw;
    if (maxKva > plantMaxKVA) plantMaxKVA = maxKva;
    pfSum += avgPf;

    sheet1.addRow({
      deviceId,
      kwh: parseFloat(kwh.toFixed(1)),
      kvah: parseFloat(kvah.toFixed(1)),
      maxKw: parseFloat(maxKw.toFixed(2)),
      maxKva: parseFloat(maxKva.toFixed(2)),
      avgPf: parseFloat(avgPf.toFixed(3))
    });
  }

  // Combined Total Row
  const totalRow = sheet1.addRow({
    deviceId: 'PLANT TOTAL',
    kwh: parseFloat(plantKWh.toFixed(1)),
    kvah: parseFloat(plantKVAh.toFixed(1)),
    maxKw: parseFloat(plantMaxKW.toFixed(2)),
    maxKva: parseFloat(plantMaxKVA.toFixed(2)),
    avgPf: parseFloat((deviceIds.length > 0 ? pfSum / deviceIds.length : 0).toFixed(3))
  });
  totalRow.font = { bold: true };

  // Tab 2: Hourly Comparison Breakdown
  const sheet2 = workbook.addWorksheet('Hourly Breakdown');
  const hourlyCols = [{ header: 'Hour', key: 'hour', width: 12 }];

  deviceIds.forEach(id => {
    hourlyCols.push({ header: `${id} (KW)`, key: `${id}_kw`, width: 16 });
    hourlyCols.push({ header: `${id} (KVA)`, key: `${id}_kva`, width: 16 });
  });

  hourlyCols.push({ header: 'Total Plant KW', key: 'total_kw', width: 18 });
  hourlyCols.push({ header: 'Total Plant KVA', key: 'total_kva', width: 18 });

  sheet2.columns = hourlyCols;
  sheet2.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  sheet2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E293B' } };

  // Fetch all points for all devices
  const allPoints = await MeterData.find({
    deviceId: { $in: deviceIds },
    timestamp: { $gte: start, $lte: end }
  }).lean();

  for (let h = 0; h < 24; h++) {
    const rowObj = { hour: `${h.toString().padStart(2, '0')}:00` };
    let hourTotalKw = 0;
    let hourTotalKva = 0;

    deviceIds.forEach(id => {
      const devPts = allPoints.filter(d => d.deviceId === id && new Date(d.timestamp).getHours() === h);
      if (devPts.length > 0) {
        const avgKw = devPts.reduce((a, b) => a + (b.KW || 0), 0) / devPts.length;
        const avgKva = devPts.reduce((a, b) => a + (b.KVA || 0), 0) / devPts.length;
        rowObj[`${id}_kw`] = parseFloat(avgKw.toFixed(2));
        rowObj[`${id}_kva`] = parseFloat(avgKva.toFixed(2));
        hourTotalKw += avgKw;
        hourTotalKva += avgKva;
      } else {
        rowObj[`${id}_kw`] = 0;
        rowObj[`${id}_kva`] = 0;
      }
    });

    rowObj['total_kw'] = parseFloat(hourTotalKw.toFixed(2));
    rowObj['total_kva'] = parseFloat(hourTotalKva.toFixed(2));

    sheet2.addRow(rowObj);
  }

  // Tab 3: Raw Logs
  const sheet3 = workbook.addWorksheet('Raw Logs');
  sheet3.columns = [
    { header: 'Device ID', key: 'deviceId', width: 18 },
    { header: 'Timestamp', key: 'timestamp', width: 25 },
    { header: 'KW', key: 'kw', width: 12 },
    { header: 'KVA', key: 'kva', width: 12 },
    { header: 'PF', key: 'pf', width: 12 },
    { header: 'KWH', key: 'kwh', width: 15 },
    { header: 'KVAH', key: 'kvah', width: 15 },
  ];

  sheet3.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' } };
  sheet3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '334155' } };

  allPoints.forEach(r => {
    sheet3.addRow({
      deviceId: r.deviceId,
      timestamp: new Date(r.timestamp).toLocaleString(),
      kw: r.KW || 0,
      kva: r.KVA || 0,
      pf: r.PF || 0,
      kwh: r.KWH || 0,
      kvah: r.KVAH || 0
    });
  });

  return await workbook.xlsx.writeBuffer();
}

module.exports = {
  generateMultiDeviceGraph,
  generateMultiDevicePDFReport,
  generateMultiDeviceExcelData
};
