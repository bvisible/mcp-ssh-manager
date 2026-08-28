/**
 * Backup Workflow Examples for MCP SSH Manager
 *
 * This file demonstrates various backup and restore workflows
 * that can be executed through Claude Code or OpenAI Codex.
 */

// ============================================================================
// EXAMPLE 1: Simple MySQL Backup Before Deployment
// ============================================================================

/*
User: "Backup production database before deployment"

AI executes:
*/
const mysqlBackup = {
  tool: 'ssh_backup_create',
  params: {
    server: 'production',
    type: 'mysql',
    name: 'pre-deployment',
    database: 'myapp_prod',
    dbUser: 'backup_user',
    dbPassword: process.env.DB_PASSWORD,  // From environment
    retention: 7  // Keep for 7 days
  }
};

// Response:
// {
//   "success": true,
//   "backup_id": "mysql_pre-deployment_2025-10-01T10-30-45-000Z_abc123de",
//   "size_human": "50.00 MB",
//   "location": "/var/backups/ssh-manager/mysql_pre-deployment_2025-10-01T10-30-45-000Z_abc123de.gz"
// }

// ============================================================================
// EXAMPLE 2: PostgreSQL Backup with Custom Retention
// ============================================================================

/*
User: "Create PostgreSQL backup and keep it for 30 days"
*/
const postgresBackup = {
  tool: 'ssh_backup_create',
  params: {
    server: 'staging',
    type: 'postgresql',
    name: 'monthly-backup',
    database: 'analytics_db',
    dbUser: 'postgres',
    dbPassword: process.env.PG_PASSWORD,
    retention: 30,  // Keep for 30 days
    compress: true
  }
};

// ============================================================================
// EXAMPLE 3: Files Backup with Exclusions
// ============================================================================

/*
User: "Backup website files excluding cache and logs"
*/
const filesBackup = {
  tool: 'ssh_backup_create',
  params: {
    server: 'web01',
    type: 'files',
    name: 'website-files',
    paths: [
      '/var/www/html',
      '/etc/nginx',
      '/home/deploy/config'
    ],
    exclude: [
      'cache/*',
      '*.log',
      'node_modules/',
      '*.tmp'
    ],
    retention: 14
  }
};

// ============================================================================
// EXAMPLE 4: MongoDB Backup
// ============================================================================

/*
User: "Backup MongoDB user database"
*/
const mongoBackup = {
  tool: 'ssh_backup_create',
  params: {
    server: 'mongodb01',
    type: 'mongodb',
    name: 'users-db',
    database: 'users',
    dbHost: 'localhost',
    dbPort: 27017,
    dbUser: 'admin',
    dbPassword: process.env.MONGO_PASSWORD,
    retention: 7
  }
};

// ============================================================================
// EXAMPLE 5: List All Backups
// ============================================================================

/*
User: "Show me all MySQL backups on production"
*/
const listBackups = {
  tool: 'ssh_backup_list',
  params: {
    server: 'production',
    type: 'mysql'  // Optional: filter by type
  }
};

// Response:
// {
//   "success": true,
//   "count": 5,
//   "backups": [
//     {
//       "id": "mysql_pre-deployment_2025-10-01T10-30-45-000Z_abc123de",
//       "type": "mysql",
//       "created_at": "2025-10-01T10:30:45.000Z",
//       "database": "myapp_prod",
//       "size_human": "50.00 MB",
//       "retention_days": 7
//     }
//   ]
// }

// ============================================================================
// EXAMPLE 6: Restore from Backup
// ============================================================================

/*
User: "Restore the latest production backup"
*/

// Step 1: List backups to find the ID
const listFirst = {
  tool: 'ssh_backup_list',
  params: {
    server: 'production',
    type: 'mysql'
  }
};

// Step 2: Restore using the backup ID
const restoreBackup = {
  tool: 'ssh_backup_restore',
  params: {
    server: 'production',
    backupId: 'mysql_pre-deployment_2025-10-01T10-30-45-000Z_abc123de',
    database: 'myapp_prod',  // Can restore to different database
    dbUser: 'restore_user',
    dbPassword: process.env.DB_PASSWORD
  }
};

// ============================================================================
// EXAMPLE 7: Schedule Daily Backups
// ============================================================================

/*
User: "Schedule daily MySQL backup at 2 AM"
*/
const scheduleDaily = {
  tool: 'ssh_backup_schedule',
  params: {
    server: 'production',
    schedule: '0 2 * * *',  // Daily at 2 AM
    type: 'mysql',
    name: 'daily-prod',
    database: 'myapp_prod',
    retention: 7  // Keep last 7 days
  }
};

// ============================================================================
// EXAMPLE 8: Schedule Weekly Full Backup
// ============================================================================

/*
User: "Schedule weekly full backup every Sunday at midnight"
*/
const scheduleWeekly = {
  tool: 'ssh_backup_schedule',
  params: {
    server: 'production',
    schedule: '0 0 * * 0',  // Sunday at midnight
    type: 'mysql',
    name: 'weekly-full',
    database: 'myapp_prod',
    retention: 30  // Keep for 4 weeks
  }
};

// ============================================================================
// EXAMPLE 9: Multi-Server Backup Strategy
// ============================================================================

/*
User: "Backup all production databases"
*/

// Production MySQL
const prodMysql = {
  tool: 'ssh_backup_create',
  params: {
    server: 'prod-mysql',
    type: 'mysql',
    name: 'prod-mysql-backup',
    database: 'main_db'
  }
};

// Production PostgreSQL
const prodPostgres = {
  tool: 'ssh_backup_create',
  params: {
    server: 'prod-postgres',
    type: 'postgresql',
    name: 'prod-pg-backup',
    database: 'analytics'
  }
};

// Production MongoDB
const prodMongo = {
  tool: 'ssh_backup_create',
  params: {
    server: 'prod-mongo',
    type: 'mongodb',
    name: 'prod-mongo-backup',
    database: 'sessions'
  }
};

// ============================================================================
// EXAMPLE 10: Pre-Deployment Workflow
// ============================================================================

/*
Complete deployment workflow with backup safety net
*/

async function preDeploymentWorkflow() {
  // Step 1: Create backup
  console.log("Creating pre-deployment backup...");
  const backup = await createBackup({
    server: 'production',
    type: 'mysql',
    name: 'pre-deploy',
    database: 'myapp_prod'
  });

  console.log(`Backup created: ${backup.backup_id}`);

  // Step 2: Deploy changes
  console.log("Deploying new version...");
  await deploy({
    server: 'production',
    branch: 'main'
  });

  // Step 3: Run health check
  console.log("Running health checks...");
  const health = await healthCheck({
    server: 'production'
  });

  // Step 4: If deployment fails, restore backup
  if (!health.success) {
    console.error("Deployment failed! Rolling back...");
    await restoreBackup({
      server: 'production',
      backupId: backup.backup_id
    });
    console.log("Rollback completed");
  } else {
    console.log("Deployment successful!");
  }
}

// ============================================================================
// EXAMPLE 11: Disaster Recovery Workflow
// ============================================================================

/*
User: "Recover production database from yesterday's backup"
*/

async function disasterRecovery() {
  // Step 1: List all backups
  const backups = await listBackups({
    server: 'production',
    type: 'mysql'
  });

  // Step 2: Find yesterday's backup
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const yesterdayBackup = backups.backups.find(b => {
    const backupDate = new Date(b.created_at);
    return backupDate.toDateString() === yesterday.toDateString();
  });

  if (!yesterdayBackup) {
    throw new Error("No backup found from yesterday");
  }

  // Step 3: Restore
  console.log(`Restoring backup: ${yesterdayBackup.id}`);
  await restoreBackup({
    server: 'production',
    backupId: yesterdayBackup.id
  });

  console.log("Recovery completed successfully");
}

// ============================================================================
// EXAMPLE 12: Backup to Remote Storage (S3)
// ============================================================================

/*
User: "Backup database and upload to S3"
*/

async function backupToS3() {
  // Step 1: Create local backup
  const backup = await createBackup({
    server: 'production',
    type: 'mysql',
    name: 'prod-db',
    database: 'myapp_prod'
  });

  // Step 2: Download backup from server
  await downloadFile({
    server: 'production',
    remotePath: backup.location,
    localPath: '/tmp/backup.gz'
  });

  // Step 3: Upload to S3 (requires AWS CLI on local machine)
  await executeLocal(
    `aws s3 cp /tmp/backup.gz s3://my-backups/${backup.backup_id}.gz`
  );

  // Step 4: Clean up local file
  await executeLocal('rm /tmp/backup.gz');

  console.log(`Backup uploaded to S3: s3://my-backups/${backup.backup_id}.gz`);
}

// ============================================================================
// EXAMPLE 13: Compliance Backup (90-day retention)
// ============================================================================

/*
User: "Create compliance backup with 90-day retention"
*/
const complianceBackup = {
  tool: 'ssh_backup_create',
  params: {
    server: 'production',
    type: 'mysql',
    name: 'compliance-q4-2025',
    database: 'financial_data',
    retention: 90,  // 90 days for compliance
    compress: true
  }
};

// Schedule monthly compliance backups
const monthlyCompliance = {
  tool: 'ssh_backup_schedule',
  params: {
    server: 'production',
    schedule: '0 3 1 * *',  // 1st of each month at 3 AM
    type: 'mysql',
    name: 'monthly-compliance',
    database: 'financial_data',
    retention: 365  // Keep for 1 year
  }
};

// ============================================================================
// CRON SCHEDULE REFERENCE
// ============================================================================

// Common cron schedules:
//
// Daily:
//   - "0 2 * * *"        // Every day at 2 AM
//   - "0 0 * * *"        // Every day at midnight
//
// Hourly:
//   - "0 * * * *"        // Every hour at minute 0
//   - "0 */6 * * *"      // Every 6 hours
//
// Weekly:
//   - "0 0 * * 0"        // Every Sunday at midnight
//   - "0 3 * * 1"        // Every Monday at 3 AM
//
// Monthly:
//   - "0 0 1 * *"        // 1st of month at midnight
//   - "0 2 15 * *"       // 15th of month at 2 AM
//
// Weekdays:
//   - "0 1 * * 1-5"      // Mon-Fri at 1 AM
//
// Custom:
//   - "*/30 * * * *"     // Every 30 minutes
//   - "0 */4 * * *"      // Every 4 hours
//   - "0 9-17 * * *"     // Every hour from 9 AM to 5 PM

// ============================================================================
// NOTES
// ============================================================================

/*
Best Practices:

1. Security:
   - Store passwords in environment variables
   - Use SSH keys for authentication
   - Restrict backup directory permissions (chmod 700)
   - Encrypt sensitive backups

2. Testing:
   - Test restore procedures monthly
   - Verify backup integrity
   - Document recovery times
   - Keep runbooks updated

3. Monitoring:
   - Set up alerts for backup failures
   - Monitor disk space
   - Track backup sizes and durations
   - Review retention policies quarterly

4. Storage:
   - Implement 3-2-1 backup rule
   - Consider cloud storage (S3, GCS, Azure)
   - Monitor backup costs
   - Clean up old backups

5. Compliance:
   - Follow regulatory retention requirements
   - Encrypt backups at rest
   - Maintain audit logs
   - Test disaster recovery procedures
*/

module.exports = {
  mysqlBackup,
  postgresBackup,
  filesBackup,
  mongoBackup,
  listBackups,
  restoreBackup,
  scheduleDaily,
  complianceBackup,
  preDeploymentWorkflow,
  disasterRecovery,
  backupToS3
};
