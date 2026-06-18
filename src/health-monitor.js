/**
 * Health Monitor for MCP SSH Manager
 * Provides system health checks, service monitoring, and process management
 */

import { logger } from './logger.js';

// Health status levels
export const HEALTH_STATUS = {
  HEALTHY: 'healthy',
  WARNING: 'warning',
  CRITICAL: 'critical',
  UNKNOWN: 'unknown'
};

// Common services to monitor
const COMMON_SERVICES = {
  nginx: { systemd: 'nginx', sysv: 'nginx' },
  apache: { systemd: 'apache2', sysv: 'apache2' },
  mysql: { systemd: 'mysql', sysv: 'mysql' },
  postgresql: { systemd: 'postgresql', sysv: 'postgresql' },
  mongodb: { systemd: 'mongod', sysv: 'mongod' },
  redis: { systemd: 'redis', sysv: 'redis-server' },
  docker: { systemd: 'docker', sysv: 'docker' },
  ssh: { systemd: 'sshd', sysv: 'ssh' }
};

/**
 * Build command to check CPU usage
 */
function buildCPUCheckCommand() {
  // Get CPU usage using top, show idle percentage, calculate used
  return 'top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk \'{print 100 - $1}\'';
}

/**
 * Build command to check memory usage
 */
function buildMemoryCheckCommand() {
  // Returns: total, used, free, available in MB and percentage
  return 'free -m | awk \'NR==2{printf "{\\"total\\":%s,\\"used\\":%s,\\"free\\":%s,\\"percent\\":%.2f}", $2,$3,$4,$3*100/$2}\'';
}

/**
 * Build command to check disk usage
 */
function buildDiskCheckCommand(mountPoint = '/') {
  // Returns JSON with disk usage for specific mount point or all
  if (mountPoint === 'all') {
    return 'df -h | awk \'NR>1 {gsub(/%/,"",$5); printf "{\\"mount\\":\\"%s\\",\\"size\\":\\"%s\\",\\"used\\":\\"%s\\",\\"avail\\":\\"%s\\",\\"percent\\":%s}\\n", $6,$2,$3,$4,$5}\'';
  }
  return `df -h "${mountPoint}" | awk 'NR>1 {gsub(/%/,"",$5); printf "{\\"mount\\":\\"%s\\",\\"size\\":\\"%s\\",\\"used\\":\\"%s\\",\\"avail\\":\\"%s\\",\\"percent\\":%s}", $6,$2,$3,$4,$5}'`;
}

/**
 * Build command to check network statistics
 */
function buildNetworkCheckCommand() {
  // Get basic network stats (RX/TX bytes)
  return 'cat /proc/net/dev | awk \'NR>2 {printf "{\\"interface\\":\\"%s\\",\\"rx_bytes\\":%s,\\"tx_bytes\\":%s}\\n", $1,$2,$10}\' | grep -v "lo:"';
}

/**
 * Build command to check load average
 */
function buildLoadAverageCommand() {
  return 'uptime | awk -F\'load average:\' \'{print $2}\' | sed \'s/^[ \\t]*//\'';
}

/**
 * Build command to check system uptime
 */
function buildUptimeCommand() {
  return 'uptime -p 2>/dev/null || uptime | awk \'{print $3,$4}\' | sed \'s/,//\'';
}

/**
 * Parse CPU usage output
 */
function parseCPUUsage(output) {
  const usage = parseFloat(output.trim());
  return {
    usage: usage.toFixed(2),
    percent: usage,
    status: usage > 90 ? HEALTH_STATUS.CRITICAL : usage > 70 ? HEALTH_STATUS.WARNING : HEALTH_STATUS.HEALTHY
  };
}

/**
 * Parse memory usage output
 */
function parseMemoryUsage(output) {
  try {
    const mem = JSON.parse(output.trim());
    return {
      total_mb: mem.total,
      used_mb: mem.used,
      free_mb: mem.free,
      percent: parseFloat(mem.percent),
      status: mem.percent > 90 ? HEALTH_STATUS.CRITICAL : mem.percent > 80 ? HEALTH_STATUS.WARNING : HEALTH_STATUS.HEALTHY
    };
  } catch (error) {
    logger.warn('Failed to parse memory output', { error: error.message });
    return { status: HEALTH_STATUS.UNKNOWN };
  }
}

/**
 * Parse disk usage output
 */
function parseDiskUsage(output) {
  const lines = output.trim().split('\n').filter(l => l);
  const disks = [];

  for (const line of lines) {
    try {
      const disk = JSON.parse(line);
      disk.status = disk.percent > 90 ? HEALTH_STATUS.CRITICAL : disk.percent > 80 ? HEALTH_STATUS.WARNING : HEALTH_STATUS.HEALTHY;
      disks.push(disk);
    } catch (error) {
      logger.warn('Failed to parse disk line', { line, error: error.message });
    }
  }

  return disks;
}

/**
 * Parse network statistics
 */
function parseNetworkStats(output) {
  const lines = output.trim().split('\n').filter(l => l);
  const interfaces = [];

  for (const line of lines) {
    try {
      const iface = JSON.parse(line);
      // Convert bytes to MB
      iface.rx_mb = (iface.rx_bytes / 1024 / 1024).toFixed(2);
      iface.tx_mb = (iface.tx_bytes / 1024 / 1024).toFixed(2);
      interfaces.push(iface);
    } catch (error) {
      logger.warn('Failed to parse network line', { line, error: error.message });
    }
  }

  return interfaces;
}

/**
 * Determine overall health status
 */
function determineOverallHealth(cpu, memory, disks) {
  const statuses = [cpu.status, memory.status, ...disks.map(d => d.status)];

  if (statuses.includes(HEALTH_STATUS.CRITICAL)) {
    return HEALTH_STATUS.CRITICAL;
  }
  if (statuses.includes(HEALTH_STATUS.WARNING)) {
    return HEALTH_STATUS.WARNING;
  }
  if (statuses.includes(HEALTH_STATUS.UNKNOWN)) {
    return HEALTH_STATUS.UNKNOWN;
  }
  return HEALTH_STATUS.HEALTHY;
}

/**
 * Build command to check service status (systemd or sysv)
 */
export function buildServiceStatusCommand(serviceName) {
  // Try systemd first, fallback to sysv
  return `
    if command -v systemctl >/dev/null 2>&1; then
      systemctl is-active ${serviceName} 2>/dev/null >/dev/null && echo "ACTIVE" || echo "INACTIVE"
      systemctl is-enabled ${serviceName} 2>/dev/null >/dev/null && echo "ENABLED" || echo "DISABLED"
      systemctl status ${serviceName} 2>/dev/null | grep "Main PID" | awk '{print $3}' | cut -d'(' -f1
      systemctl status ${serviceName} 2>/dev/null | grep "Active:" | sed 's/.*Active: //' | awk '{print $1,$2,$3}'
    elif command -v service >/dev/null 2>&1; then
      service ${serviceName} status >/dev/null 2>&1 && echo "ACTIVE" || echo "INACTIVE"
      echo "UNKNOWN"
      pgrep -f ${serviceName} | head -1 || echo ""
      echo "sysv"
    else
      echo "UNKNOWN"
      echo "UNKNOWN"
      echo ""
      echo "no-init-system"
    fi
  `.trim();
}

/**
 * Parse service status output
 */
export function parseServiceStatus(output, serviceName) {
  const lines = output.trim().split('\n');
  const [status, enabled, pid, details] = lines;

  return {
    name: serviceName,
    status: status === 'ACTIVE' ? 'running' : 'stopped',
    enabled: enabled === 'ENABLED' ? 'yes' : enabled === 'DISABLED' ? 'no' : 'unknown',
    pid: pid && pid !== '' ? parseInt(pid) : null,
    details: details || 'unknown',
    health: status === 'ACTIVE' ? HEALTH_STATUS.HEALTHY : HEALTH_STATUS.CRITICAL
  };
}

/**
 * Build command to list running processes
 */
export function buildProcessListCommand(options = {}) {
  const {
    sortBy = 'cpu',  // cpu, memory, pid
    limit = 20,
    filter = null
  } = options;

  let sortFlag = sortBy === 'memory' ? '-m' : '-c';  // -c for CPU, -m for memory
  let command = `ps aux --sort=${sortFlag === '-c' ? '-pcpu' : '-pmem'} | head -n ${limit + 1}`;

  if (filter) {
    command += ` | grep -i "${filter}"`;
  }

  // Format output as JSON-like structure
  command += ' | awk \'NR>1 {printf "{\\"user\\":\\"%s\\",\\"pid\\":%s,\\"cpu\\":%.1f,\\"mem\\":%.1f,\\"vsz\\":%s,\\"rss\\":%s,\\"stat\\":\\"%s\\",\\"start\\":\\"%s\\",\\"time\\":\\"%s\\",\\"command\\":\\"%s\\"}\\n", $1,$2,$3,$4,$5,$6,$8,$9,$10,substr($0,index($0,$11))}\'';

  return command;
}

/**
 * Parse process list output
 */
export function parseProcessList(output) {
  const lines = output.trim().split('\n').filter(l => l);
  const processes = [];

  for (const line of lines) {
    try {
      const proc = JSON.parse(line);
      processes.push(proc);
    } catch (error) {
      logger.warn('Failed to parse process line', { line, error: error.message });
    }
  }

  return processes;
}

/**
 * Build command to kill a process
 */
export function buildKillProcessCommand(pid, signal = 'TERM') {
  // Validate PID is numeric
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid PID: ${pid}`);
  }

  const validSignals = ['TERM', 'KILL', 'HUP', 'INT', 'QUIT'];
  if (!validSignals.includes(signal)) {
    throw new Error(`Invalid signal: ${signal}. Valid signals: ${validSignals.join(', ')}`);
  }

  return `kill -${signal} ${pid}`;
}

/**
 * Build command to get process info
 */
export function buildProcessInfoCommand(pid) {
  return `ps -p ${pid} -o user,pid,pcpu,pmem,vsz,rss,stat,start,time,cmd --no-headers | awk '{printf "{\\"user\\":\\"%s\\",\\"pid\\":%s,\\"cpu\\":%.1f,\\"mem\\":%.1f,\\"vsz\\":%s,\\"rss\\":%s,\\"stat\\":\\"%s\\",\\"start\\":\\"%s\\",\\"time\\":\\"%s\\",\\"command\\":\\"%s\\"}", $1,$2,$3,$4,$5,$6,$7,$8,$9,substr($0,index($0,$10))}'`;
}

/**
 * Create alert configuration
 */
export function createAlertConfig(thresholds) {
  const defaults = {
    cpu: 80,
    memory: 90,
    disk: 85,
    enabled: true
  };

  return {
    ...defaults,
    ...thresholds,
    created_at: new Date().toISOString()
  };
}

/**
 * Build command to save alert config
 */
export function buildSaveAlertConfigCommand(config, configPath = '/etc/ssh-manager-alerts.json') {
  const jsonData = JSON.stringify(config, null, 2);
  const escapedJson = jsonData.replace(/'/g, '\'\\\'\'');
  return `echo '${escapedJson}' > "${configPath}"`;
}

/**
 * Build command to load alert config
 */
export function buildLoadAlertConfigCommand(configPath = '/etc/ssh-manager-alerts.json') {
  return `cat "${configPath}" 2>/dev/null || echo '{}'`;
}

/**
 * Check if thresholds are exceeded
 */
export function checkAlertThresholds(metrics, thresholds) {
  const alerts = [];

  if (thresholds.cpu && metrics.cpu && metrics.cpu.percent > thresholds.cpu) {
    alerts.push({
      type: 'cpu',
      severity: 'warning',
      message: `CPU usage (${metrics.cpu.percent}%) exceeds threshold (${thresholds.cpu}%)`,
      value: metrics.cpu.percent,
      threshold: thresholds.cpu
    });
  }

  if (thresholds.memory && metrics.memory && metrics.memory.percent > thresholds.memory) {
    alerts.push({
      type: 'memory',
      severity: 'warning',
      message: `Memory usage (${metrics.memory.percent}%) exceeds threshold (${thresholds.memory}%)`,
      value: metrics.memory.percent,
      threshold: thresholds.memory
    });
  }

  if (thresholds.disk && metrics.disks) {
    for (const disk of metrics.disks) {
      if (disk.percent > thresholds.disk) {
        alerts.push({
          type: 'disk',
          severity: 'warning',
          message: `Disk usage on ${disk.mount} (${disk.percent}%) exceeds threshold (${thresholds.disk}%)`,
          mount: disk.mount,
          value: disk.percent,
          threshold: thresholds.disk
        });
      }
    }
  }

  return alerts;
}

/**
 * Build comprehensive health check command
 */
export function buildComprehensiveHealthCheckCommand() {
  return `
    echo "=== CPU ==="
    ${buildCPUCheckCommand()}
    echo "=== MEMORY ==="
    ${buildMemoryCheckCommand()}
    echo "=== DISK ==="
    ${buildDiskCheckCommand('all')}
    echo "=== LOAD ==="
    ${buildLoadAverageCommand()}
    echo "=== UPTIME ==="
    ${buildUptimeCommand()}
    echo "=== NETWORK ==="
    ${buildNetworkCheckCommand()}
  `.trim();
}

/**
 * Parse comprehensive health check output
 */
export function parseComprehensiveHealthCheck(output) {
  const sections = output.split('=== ').filter(s => s);
  const result = {};

  for (const section of sections) {
    const [name, ...content] = section.split('\n');
    const data = content.join('\n').trim();

    switch (name.toLowerCase().trim()) {
    case 'cpu ===':
      result.cpu = parseCPUUsage(data);
      break;
    case 'memory ===':
      result.memory = parseMemoryUsage(data);
      break;
    case 'disk ===':
      result.disks = parseDiskUsage(data);
      break;
    case 'load ===':
      result.load_average = data;
      break;
    case 'uptime ===':
      result.uptime = data;
      break;
    case 'network ===':
      result.network = parseNetworkStats(data);
      break;
    }
  }

  // Determine overall health
  if (result.cpu && result.memory && result.disks) {
    result.overall_status = determineOverallHealth(result.cpu, result.memory, result.disks);
  }

  return result;
}

/**
 * Resolve service name (handle both systemd and sysv names)
 */
export function resolveServiceName(shortName) {
  const service = COMMON_SERVICES[shortName.toLowerCase()];
  return service ? service.systemd : shortName;
}
