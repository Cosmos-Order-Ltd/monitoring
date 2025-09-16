import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { WebSocketServer } from 'ws';
import http from 'http';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 9090;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Service endpoints to monitor
const services = [
  { name: 'backend', url: 'http://localhost:5000/health' },
  { name: 'core', url: 'http://localhost:3000/health' },
  { name: 'admin', url: 'http://localhost:3010' },
  { name: 'guest', url: 'http://localhost:3011' },
  { name: 'staff', url: 'http://localhost:3012' },
  { name: 'marketplace', url: 'http://localhost:3013' },
  { name: 'gateway', url: 'http://localhost:8080/health' }
];

interface ServiceStatus {
  name: string;
  status: 'healthy' | 'unhealthy' | 'unknown';
  responseTime: number;
  lastCheck: Date;
  uptime: number;
  error?: string;
}

let serviceStatuses: Map<string, ServiceStatus> = new Map();

// Health check function
async function checkServiceHealth(service: { name: string; url: string }): Promise<ServiceStatus> {
  const startTime = Date.now();

  try {
    const response = await axios.get(service.url, {
      timeout: 5000,
      validateStatus: (status) => status < 500 // Accept any status < 500 as "healthy"
    });

    const responseTime = Date.now() - startTime;

    return {
      name: service.name,
      status: 'healthy',
      responseTime,
      lastCheck: new Date(),
      uptime: response.status === 200 ? 100 : 90 // Simplified uptime calculation
    };
  } catch (error: any) {
    const responseTime = Date.now() - startTime;

    return {
      name: service.name,
      status: 'unhealthy',
      responseTime,
      lastCheck: new Date(),
      uptime: 0,
      error: error.message
    };
  }
}

// Monitor all services
async function monitorServices(): Promise<void> {
  console.log('🔍 Checking service health...');

  const promises = services.map(service => checkServiceHealth(service));
  const results = await Promise.allSettled(promises);

  results.forEach((result, index) => {
    const serviceName = services[index]?.name || 'unknown';

    if (result.status === 'fulfilled') {
      const statusResult = result.value;
      serviceStatuses.set(serviceName, statusResult);
      console.log(`${statusResult.status === 'healthy' ? '✅' : '❌'} ${serviceName}: ${statusResult.status} (${statusResult.responseTime}ms)`);
    } else {
      serviceStatuses.set(serviceName, {
        name: serviceName,
        status: 'unknown',
        responseTime: 0,
        lastCheck: new Date(),
        uptime: 0,
        error: 'Health check failed'
      });
      console.log(`❌ ${serviceName}: unknown (health check failed)`);
    }
  });

  // Broadcast to WebSocket clients
  broadcastStatus();
}

// WebSocket setup
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients: Set<any> = new Set();

wss.on('connection', (ws) => {
  console.log('📡 New monitoring client connected');
  clients.add(ws);

  // Send current status immediately
  ws.send(JSON.stringify({
    type: 'status',
    data: Array.from(serviceStatuses.values())
  }));

  ws.on('close', () => {
    clients.delete(ws);
    console.log('📡 Monitoring client disconnected');
  });
});

function broadcastStatus(): void {
  const statusData = {
    type: 'status',
    data: Array.from(serviceStatuses.values()),
    timestamp: new Date().toISOString()
  };

  clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(JSON.stringify(statusData));
    }
  });
}

// API Routes
app.get('/health', (_req, res) => {
  res.json({
    status: 'OK',
    service: 'pms-monitoring',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get('/api/status', (_req, res) => {
  const statuses = Array.from(serviceStatuses.values());
  const healthyCount = statuses.filter(s => s.status === 'healthy').length;

  res.json({
    success: true,
    summary: {
      totalServices: statuses.length,
      healthyServices: healthyCount,
      unhealthyServices: statuses.length - healthyCount,
      overallHealth: healthyCount === statuses.length ? 'healthy' : 'degraded'
    },
    services: statuses
  });
});

app.get('/api/service/:name', (req, res) => {
  const { name } = req.params;
  const service = serviceStatuses.get(name);

  if (!service) {
    return res.status(404).json({
      success: false,
      message: 'Service not found'
    });
  }

  return res.json({
    success: true,
    service
  });
});

// Serve monitoring dashboard
app.get('/', (_req, res) => {
  return res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>PMS Monitoring Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .services { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .service-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .service-card.healthy { border-left: 4px solid #4CAF50; }
        .service-card.unhealthy { border-left: 4px solid #f44336; }
        .service-card.unknown { border-left: 4px solid #ff9800; }
        .status { font-weight: bold; text-transform: uppercase; }
        .healthy { color: #4CAF50; }
        .unhealthy { color: #f44336; }
        .unknown { color: #ff9800; }
        .metric { margin: 10px 0; }
        .metric label { font-weight: bold; margin-right: 10px; }
        .last-updated { text-align: center; margin-top: 20px; color: #666; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔍 PMS Monitoring Dashboard</h1>
            <p>Real-time monitoring of all PMS microservices</p>
        </div>
        <div id="services" class="services">
            <div>Loading services...</div>
        </div>
        <div class="last-updated" id="lastUpdated"></div>
    </div>

    <script>
        const ws = new WebSocket('ws://localhost:${PORT}');

        ws.onmessage = function(event) {
            const data = JSON.parse(event.data);
            if (data.type === 'status') {
                updateServices(data.data);
                document.getElementById('lastUpdated').textContent =
                    'Last updated: ' + new Date(data.timestamp).toLocaleString();
            }
        };

        function updateServices(services) {
            const container = document.getElementById('services');
            container.innerHTML = services.map(service => \`
                <div class="service-card \${service.status}">
                    <h3>\${service.name.toUpperCase()}</h3>
                    <div class="metric">
                        <label>Status:</label>
                        <span class="status \${service.status}">\${service.status}</span>
                    </div>
                    <div class="metric">
                        <label>Response Time:</label>
                        <span>\${service.responseTime}ms</span>
                    </div>
                    <div class="metric">
                        <label>Last Check:</label>
                        <span>\${new Date(service.lastCheck).toLocaleTimeString()}</span>
                    </div>
                    \${service.error ? \`<div class="metric"><label>Error:</label><span style="color: red;">\${service.error}</span></div>\` : ''}
                </div>
            \`).join('');
        }
    </script>
</body>
</html>
  `);
});

// Start monitoring
setInterval(monitorServices, 30000); // Check every 30 seconds
monitorServices(); // Initial check

// Start server
server.listen(PORT, () => {
  console.log(`🚀 PMS Monitoring Dashboard running on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}`);
  console.log(`🔍 Monitoring ${services.length} services`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    process.exit(0);
  });
});