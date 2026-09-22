const ExcelJS = require('exceljs');
const QuickChart = require('quickchart-js');
const PDFDocument = require('pdfkit');
const MeterData = require('../models/MeterData');
const DailyUsage = require('../models/DailyUsage');

// Curated color palette for multiple devices in graphs & tables
const DEVICE_COLORS = ['#2563EB', '#16A34A', '#D97706', '#9333EA', '#DC2626', '#0891B2'];

/**
 * IST (Asia/Kolkata / UTC+5:30) Timezone Helpers
 */
function getISTHour(date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false
  });
  return parseInt(formatter.format(new Date(date)), 10) % 24;
}

function getISTMidnight(date = new Date()) {
  const istDateStr = new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return new Date(`${istDateStr}T00:00:00+05:30`);
}

function getISTEndOfDay(date = new Date()) {
  const istDateStr = new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return new Date(`${istDateStr}T23:59:59.999+05:30`);
}

function formatISTDateTime(date) {
  return new Date(date).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

/**
 * Helper: Generate Active Power (KW) 24-Hour Load Profile Chart from Raw Data
 */
async function generateActivePowerChart(deviceIds, allPoints) {
  const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`);
  const datasets = deviceIds.map((id, idx) => {
    const data = hours.map((_, h) => {
      const pts = allPoints.filter(p => p.deviceId === id && getISTHour(p.timestamp) === h);
      if (pts.length === 0) return 0;
      const avg = pts.reduce((sum, p) => sum + (p.KW || 0), 0) / pts.length;
      return parseFloat(avg.toFixed(2));
    });
    return {
      label: `${id} (KW)`,
      data,
      borderColor: DEVICE_COLORS[idx % DEVICE_COLORS.length],
      backgroundColor: 'transparent',
      borderWidth: 2.5,
      pointRadius: 2.5,
      tension: 0.3
    };
  });

  const chart = new QuickChart();
  chart.setConfig({
    type: 'line',
    data: { labels: hours, datasets },
    options: {
      title: {
        display: true,
        text: '24-Hour Active Power (KW) Load Profile (IST)',
        fontSize: 14,
        fontColor: '#0F172A',
        fontStyle: 'bold'
      },
      legend: { position: 'top', labels: { boxWidth: 14, fontSize: 11 } },
      scales: {
        yAxes: [{
          ticks: { beginAtZero: true },
          scaleLabel: { display: true, labelString: 'Active Power (KW)', fontStyle: 'bold' }
        }],
        xAxes: [{
          scaleLabel: { display: true, labelString: 'Hour of Day (IST Timeline)', fontStyle: 'bold' }
        }]
      }
    }
  });
  chart.setWidth(750).setHeight(330);
  chart.setBackgroundColor('#ffffff');
  try {
    return await chart.toBinary();
  } catch (err) {
    console.error('⚠️ Error rendering Active Power chart:', err.message);
    return null;
  }
}

/**
 * Helper: Generate Apparent Power (KVA) 24-Hour Demand Profile Chart from Raw Data
 */
async function generateApparentPowerChart(deviceIds, allPoints) {
  const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`);
  const datasets = deviceIds.map((id, idx) => {
    const data = hours.map((_, h) => {
      const pts = allPoints.filter(p => p.deviceId === id && getISTHour(p.timestamp) === h);
      if (pts.length === 0) return 0;
      const avg = pts.reduce((sum, p) => sum + (p.KVA || 0), 0) / pts.length;
      return parseFloat(avg.toFixed(2));
    });
    return {
      label: `${id} (KVA)`,
      data,
      borderColor: DEVICE_COLORS[idx % DEVICE_COLORS.length],
      backgroundColor: 'transparent',
      borderWidth: 2.5,
      pointRadius: 2.5,
      tension: 0.3
    };
  });

  const chart = new QuickChart();
  chart.setConfig({
    type: 'line',
    data: { labels: hours, datasets },
    options: {
      title: {
        display: true,
        text: '24-Hour Apparent Power (KVA) Demand Profile (IST)',
        fontSize: 14,
        fontColor: '#0F172A',
        fontStyle: 'bold'
      },
      legend: { position: 'top', labels: { boxWidth: 14, fontSize: 11 } },
      scales: {
        yAxes: [{
          ticks: { beginAtZero: true },
          scaleLabel: { display: true, labelString: 'Apparent Power (KVA)', fontStyle: 'bold' }
        }],
        xAxes: [{
          scaleLabel: { display: true, labelString: 'Hour of Day (IST Timeline)', fontStyle: 'bold' }
        }]
      }
    }
  });
  chart.setWidth(750).setHeight(330);
  chart.setBackgroundColor('#ffffff');
  try {
    return await chart.toBinary();
  } catch (err) {
    console.error('⚠️ Error rendering Apparent Power chart:', err.message);
    return null;
  }
}

/**
 * Helper: Generate Power Factor (PF) Stability Curve from Raw Data
 */
async function generatePowerFactorChart(deviceIds, allPoints) {
  const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`);
  const datasets = deviceIds.map((id, idx) => {
    const data = hours.map((_, h) => {
      const pts = allPoints.filter(p => p.deviceId === id && getISTHour(p.timestamp) === h);
      if (pts.length === 0) return 0;
      const avg = pts.reduce((sum, p) => sum + (p.PF || 0), 0) / pts.length;
      return parseFloat(avg.toFixed(3));
    });
    return {
      label: `${id} (PF)`,
      data,
      borderColor: DEVICE_COLORS[idx % DEVICE_COLORS.length],
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 2.5,
      tension: 0.3
    };
  });

  const chart = new QuickChart();
  chart.setConfig({
    type: 'line',
    data: { labels: hours, datasets },
    options: {
      title: {
        display: true,
        text: '24-Hour Power Factor (PF) Stability Curve (IST)',
        fontSize: 14,
        fontColor: '#0F172A',
        fontStyle: 'bold'
      },
      legend: { position: 'top', labels: { boxWidth: 14, fontSize: 11 } },
      scales: {
        yAxes: [{
          ticks: { min: 0.70, max: 1.02 },
          scaleLabel: { display: true, labelString: 'Power Factor (0.70 - 1.00)', fontStyle: 'bold' }
        }],
        xAxes: [{
          scaleLabel: { display: true, labelString: 'Hour of Day (IST Timeline)', fontStyle: 'bold' }
        }]
      }
    }
  });
  chart.setWidth(750).setHeight(330);
  chart.setBackgroundColor('#ffffff');
  try {
    return await chart.toBinary();
  } catch (err) {
    console.error('⚠️ Error rendering Power Factor chart:', err.message);
    return null;
  }
}

/**
 * Helper: Generate Total Plant Active KW vs Apparent KVA Demand Chart
 */
async function generatePlantDemandComparisonChart(hours, totalKwList, totalKvaList) {
  const chart = new QuickChart();
  chart.setConfig({
    type: 'bar',
    data: {
      labels: hours,
      datasets: [
        {
          type: 'line',
          label: 'Total Plant Apparent (KVA)',
          data: totalKvaList,
          borderColor: '#DC2626',
          borderWidth: 2.5,
          fill: false,
          pointRadius: 3,
          tension: 0.3
        },
        {
          type: 'bar',
          label: 'Total Plant Active (KW)',
          data: totalKwList,
          backgroundColor: 'rgba(37, 99, 235, 0.65)',
          borderColor: '#2563EB',
          borderWidth: 1
        }
      ]
    },
    options: {
      title: {
        display: true,
        text: 'Collective Plant Active (KW) vs Apparent (KVA) Demand (IST)',
        fontSize: 14,
        fontColor: '#0F172A',
        fontStyle: 'bold'
      },
      legend: { position: 'top', labels: { boxWidth: 14, fontSize: 11 } },
      scales: {
        yAxes: [{
          ticks: { beginAtZero: true },
          scaleLabel: { display: true, labelString: 'Power (kW / kVA)', fontStyle: 'bold' }
        }],
        xAxes: [{
          scaleLabel: { display: true, labelString: 'Hour of Day (IST)', fontStyle: 'bold' }
        }]
      }
    }
  });
  chart.setWidth(750).setHeight(330);
  chart.setBackgroundColor('#ffffff');
  try {
    return await chart.toBinary();
  } catch (err) {
    console.error('⚠️ Error rendering Plant Demand comparison chart:', err.message);
    return null;
  }
}

/**
 * Generate Combined Multi-Device 24-Hour Graph Image Buffer (legacy fallback)
 */
async function generateMultiDeviceGraph(deviceIds, date) {
  const start = getISTMidnight(date);
  const end = getISTEndOfDay(date);

  const rawData = await MeterData.find({
    deviceId: { $in: deviceIds },
    timestamp: { $gte: start, $lte: end }
  }).sort({ timestamp: 1 }).lean();

  return await generateActivePowerChart(deviceIds, rawData);
}

/**
 * Generate Multi-Device PDF Report Buffer (pdfkit) - legacy fallback
 */
async function generateMultiDevicePDFReport(deviceSummaries, dateStr, chartBuffer) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    // Header Title
    doc.rect(40, 40, 515, 50).fill('#0F172A');
    doc.fillColor('#FFFFFF').fontSize(18).text('RICE MILL MULTI-DEVICE DAILY ENERGY REPORT', 50, 50, { align: 'center' });
    const devListStr = deviceSummaries.map(d => d.deviceId).join(', ');
    doc.fontSize(8).fillColor('#94A3B8').text(`Devices: ${devListStr}   |   Date: ${dateStr} (IST)`, { align: 'center' });

    doc.moveDown(2.5);

    const totalKWh = deviceSummaries.reduce((sum, d) => sum + (d.totalKWh || 0), 0);
    const totalKVAh = deviceSummaries.reduce((sum, d) => sum + (d.totalKVAh || 0), 0);
    const peakKW = Math.max(0, ...deviceSummaries.map(d => d.maxKW || 0));
    const validPfs = deviceSummaries.map(d => d.avgPF || 0).filter(pf => pf > 0);
    const plantAvgPF = validPfs.length > 0 ? validPfs.reduce((a, b) => a + b, 0) / validPfs.length : 0;

    const gridTop = 100;
    doc.rect(40, gridTop, 515, 60).fillAndStroke('#F8FAFC', '#CBD5E1');
    doc.fillColor('#1E293B').fontSize(11).text('COLLECTIVE PLANT TOTALS', 50, gridTop + 8);
    doc.moveTo(50, gridTop + 22).lineTo(545, gridTop + 22).strokeColor('#E2E8F0').stroke();

    doc.fontSize(9).fillColor('#334155');
    const line1Y = gridTop + 28;
    doc.text(`Total Energy: `, 50, line1Y, { continued: true }).fillColor('#0F172A').text(`${totalKWh.toFixed(1)} kWh`, { continued: true });
    doc.fillColor('#334155').text(`   |   Apparent: `, { continued: true }).fillColor('#0F172A').text(`${totalKVAh.toFixed(1)} kVAh`, { continued: true });
    doc.fillColor('#334155').text(`   |   Peak KW: `, { continued: true }).fillColor('#0F172A').text(`${peakKW.toFixed(2)} kW`, { continued: true });
    doc.fillColor('#334155').text(`   |   Avg PF: `, { continued: true }).fillColor('#0F172A').text(`${plantAvgPF.toFixed(3)}`);

    if (chartBuffer) {
      doc.image(chartBuffer, 40, 180, { fit: [515, 250], align: 'center' });
    }

    doc.end();
  });
}

/**
 * Main: Generate Multi-Device Excel (.xlsx) Workbook with Visual Charts Plotted from Raw Logs
 */
async function generateMultiDeviceExcelData(deviceIds, date) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Rice Mill IoT Monitoring System';
  workbook.lastModifiedBy = 'Rice Mill Automated Reports';
  workbook.created = new Date();
  workbook.modified = new Date();

  // Compute exact IST Day Boundaries
  const start = getISTMidnight(date);
  const end = getISTEndOfDay(date);
  const dateStr = new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

  // 1. Fetch all raw logs for the target devices & date range
  const allPoints = await MeterData.find({
    deviceId: { $in: deviceIds },
    timestamp: { $gte: start, $lte: end }
  }).sort({ timestamp: 1 }).lean();

  // 2. Fetch daily summaries from DailyUsage
  const deviceSummaries = [];
  let plantKWh = 0, plantKVAh = 0, plantMaxKW = 0, plantMaxKVA = 0, pfSum = 0;

  for (const deviceId of deviceIds) {
    const summary = await DailyUsage.findOne({ deviceId, date: start }) || {};
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

    deviceSummaries.push({
      deviceId,
      totalKWh: kwh,
      totalKVAh: kvah,
      maxKW: maxKw,
      maxKVA: maxKva,
      avgPF: avgPf
    });
  }

  const plantAvgPF = deviceIds.length > 0 ? pfSum / deviceIds.length : 0;

  // 3. Compute Hourly Averages for the 24-Hour IST period
  const hours = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`);
  const hourlyRows = [];
  const plantHourlyKw = [];
  const plantHourlyKva = [];

  for (let h = 0; h < 24; h++) {
    const rowObj = { hour: `${h.toString().padStart(2, '0')}:00` };
    let hourTotalKw = 0;
    let hourTotalKva = 0;

    deviceIds.forEach(id => {
      const devPts = allPoints.filter(d => d.deviceId === id && getISTHour(d.timestamp) === h);
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
    plantHourlyKw.push(rowObj['total_kw']);
    plantHourlyKva.push(rowObj['total_kva']);

    hourlyRows.push(rowObj);
  }

  // 4. Generate High-Resolution Chart Images from the Raw Logs Data
  const [kwChartBuf, kvaChartBuf, pfChartBuf, compChartBuf] = await Promise.all([
    generateActivePowerChart(deviceIds, allPoints),
    generateApparentPowerChart(deviceIds, allPoints),
    generatePowerFactorChart(deviceIds, allPoints),
    generatePlantDemandComparisonChart(hours, plantHourlyKw, plantHourlyKva)
  ]);

  // ==========================================
  // TAB 1: Visual Analytics & Charts Dashboard
  // ==========================================
  const dashSheet = workbook.addWorksheet('Analytics & Charts', {
    views: [{ showGridLines: true }]
  });

  // Title Banner
  dashSheet.mergeCells('B2:J3');
  const titleCell = dashSheet.getCell('B2');
  titleCell.value = `RICE MILL DAILY ENERGY ANALYTICS & CHARTS DASHBOARD [${dateStr} IST]`;
  titleCell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFF' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } };

  // KPI Summary Row
  dashSheet.mergeCells('B5:C5');
  dashSheet.getCell('B5').value = 'Total Active Energy:';
  dashSheet.getCell('B5').font = { bold: true, color: { argb: '475569' } };
  dashSheet.getCell('D5').value = `${plantKWh.toFixed(1)} kWh`;
  dashSheet.getCell('D5').font = { bold: true, color: { argb: '0F172A' } };

  dashSheet.mergeCells('E5:F5');
  dashSheet.getCell('E5').value = 'Total Apparent Energy:';
  dashSheet.getCell('E5').font = { bold: true, color: { argb: '475569' } };
  dashSheet.getCell('G5').value = `${plantKVAh.toFixed(1)} kVAh`;
  dashSheet.getCell('G5').font = { bold: true, color: { argb: '0F172A' } };

  dashSheet.mergeCells('H5:I5');
  dashSheet.getCell('H5').value = 'Plant Avg Power Factor:';
  dashSheet.getCell('H5').font = { bold: true, color: { argb: '475569' } };
  dashSheet.getCell('J5').value = `${plantAvgPF.toFixed(3)}`;
  dashSheet.getCell('J5').font = { bold: true, color: { argb: '059669' } };

  // Embed Charts into Dashboard
  let currentDashRow = 7;
  if (kwChartBuf) {
    const kwImgId = workbook.addImage({ buffer: kwChartBuf, extension: 'png' });
    dashSheet.addImage(kwImgId, {
      tl: { col: 1, row: currentDashRow },
      ext: { width: 720, height: 320 }
    });
    currentDashRow += 18;
  }

  if (kvaChartBuf) {
    const kvaImgId = workbook.addImage({ buffer: kvaChartBuf, extension: 'png' });
    dashSheet.addImage(kvaImgId, {
      tl: { col: 1, row: currentDashRow },
      ext: { width: 720, height: 320 }
    });
    currentDashRow += 18;
  }

  if (pfChartBuf) {
    const pfImgId = workbook.addImage({ buffer: pfChartBuf, extension: 'png' });
    dashSheet.addImage(pfImgId, {
      tl: { col: 1, row: currentDashRow },
      ext: { width: 720, height: 320 }
    });
    currentDashRow += 18;
  }

  if (compChartBuf) {
    const compImgId = workbook.addImage({ buffer: compChartBuf, extension: 'png' });
    dashSheet.addImage(compImgId, {
      tl: { col: 1, row: currentDashRow },
      ext: { width: 720, height: 320 }
    });
  }

  // ==========================================
  // TAB 2: Collective Summary
  // ==========================================
  const sheet1 = workbook.addWorksheet('Collective Summary');
  sheet1.columns = [
    { header: 'Device ID', key: 'deviceId', width: 20 },
    { header: 'Total KWh', key: 'kwh', width: 16 },
    { header: 'Total KVAh', key: 'kvah', width: 16 },
    { header: 'Peak KW', key: 'maxKw', width: 16 },
    { header: 'Peak KVA', key: 'maxKva', width: 16 },
    { header: 'Avg PF', key: 'avgPf', width: 16 },
  ];

  sheet1.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
  sheet1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '0F172A' } };
  sheet1.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  deviceSummaries.forEach(d => {
    sheet1.addRow({
      deviceId: d.deviceId,
      kwh: parseFloat((d.totalKWh || 0).toFixed(1)),
      kvah: parseFloat((d.totalKVAh || 0).toFixed(1)),
      maxKw: parseFloat((d.maxKW || 0).toFixed(2)),
      maxKva: parseFloat((d.maxKVA || 0).toFixed(2)),
      avgPf: parseFloat((d.avgPF || 0).toFixed(3))
    });
  });

  // Combined Total Row
  const totalRow = sheet1.addRow({
    deviceId: 'PLANT TOTAL',
    kwh: parseFloat(plantKWh.toFixed(1)),
    kvah: parseFloat(plantKVAh.toFixed(1)),
    maxKw: parseFloat(plantMaxKW.toFixed(2)),
    maxKva: parseFloat(plantMaxKVA.toFixed(2)),
    avgPf: parseFloat(plantAvgPF.toFixed(3))
  });
  totalRow.font = { bold: true, color: { argb: '0F172A' } };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'F1F5F9' } };

  // Embed Comparison Chart below summary table
  if (compChartBuf) {
    const compImgId = workbook.addImage({ buffer: compChartBuf, extension: 'png' });
    sheet1.addImage(compImgId, {
      tl: { col: 0, row: deviceSummaries.length + 5 },
      ext: { width: 700, height: 320 }
    });
  }

  // ==========================================
  // TAB 3: Hourly Breakdown (IST)
  // ==========================================
  const sheet2 = workbook.addWorksheet('Hourly Breakdown (IST)');
  const hourlyCols = [{ header: 'Hour (IST)', key: 'hour', width: 14 }];

  deviceIds.forEach(id => {
    hourlyCols.push({ header: `${id} (KW)`, key: `${id}_kw`, width: 16 });
    hourlyCols.push({ header: `${id} (KVA)`, key: `${id}_kva`, width: 16 });
  });

  hourlyCols.push({ header: 'Total Plant KW', key: 'total_kw', width: 18 });
  hourlyCols.push({ header: 'Total Plant KVA', key: 'total_kva', width: 18 });

  sheet2.columns = hourlyCols;
  sheet2.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
  sheet2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E293B' } };
  sheet2.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  hourlyRows.forEach(r => {
    sheet2.addRow(r);
  });

  // ==========================================
  // TAB 4: Raw Logs (with Embedded Data Plots in IST)
  // ==========================================
  const sheet3 = workbook.addWorksheet('Raw Logs');
  sheet3.columns = [
    { header: 'Device ID', key: 'deviceId', width: 18 },
    { header: 'Timestamp (IST)', key: 'timestamp', width: 22 },
    { header: 'KW', key: 'kw', width: 12 },
    { header: 'KVA', key: 'kva', width: 12 },
    { header: 'PF', key: 'pf', width: 12 },
    { header: 'KWH', key: 'kwh', width: 15 },
    { header: 'KVAH', key: 'kvah', width: 15 },
    { header: 'V1N', key: 'v1n', width: 10 },
    { header: 'V2N', key: 'v2n', width: 10 },
    { header: 'V3N', key: 'v3n', width: 10 },
    { header: 'I1', key: 'i1', width: 10 },
    { header: 'I2', key: 'i2', width: 10 },
    { header: 'I3', key: 'i3', width: 10 },
    { header: 'Freq', key: 'freq', width: 10 },
  ];

  sheet3.getRow(1).font = { bold: true, color: { argb: 'FFFFFF' }, size: 11 };
  sheet3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '334155' } };
  sheet3.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  allPoints.forEach(r => {
    sheet3.addRow({
      deviceId: r.deviceId,
      timestamp: formatISTDateTime(r.timestamp),
      kw: r.KW || 0,
      kva: r.KVA || 0,
      pf: r.PF || 0,
      kwh: r.KWH || 0,
      kvah: r.KVAH || 0,
      v1n: r.V1N || 0,
      v2n: r.V2N || 0,
      v3n: r.V3N || 0,
      i1: r.I1 || 0,
      i2: r.I2 || 0,
      i3: r.I3 || 0,
      freq: r.Freq || 50
    });
  });

  // Plot the graphs directly in the Raw Logs sheet alongside the raw columns
  if (kwChartBuf) {
    const rawKwImgId = workbook.addImage({ buffer: kwChartBuf, extension: 'png' });
    sheet3.addImage(rawKwImgId, {
      tl: { col: 15, row: 1 },
      ext: { width: 700, height: 320 }
    });
  }

  if (pfChartBuf) {
    const rawPfImgId = workbook.addImage({ buffer: pfChartBuf, extension: 'png' });
    sheet3.addImage(rawPfImgId, {
      tl: { col: 15, row: 18 },
      ext: { width: 700, height: 320 }
    });
  }

  if (kvaChartBuf) {
    const rawKvaImgId = workbook.addImage({ buffer: kvaChartBuf, extension: 'png' });
    sheet3.addImage(rawKvaImgId, {
      tl: { col: 15, row: 35 },
      ext: { width: 700, height: 320 }
    });
  }

  return await workbook.xlsx.writeBuffer();
}

module.exports = {
  getISTHour,
  getISTMidnight,
  getISTEndOfDay,
  formatISTDateTime,
  generateMultiDeviceGraph,
  generateMultiDevicePDFReport,
  generateMultiDeviceExcelData
};
