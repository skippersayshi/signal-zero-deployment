# Signal-Zero Swarm Controller

Real-time telemetry dashboard for Swarm AI processes. Express.js + Socket.io powered with TypeScript.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

The dashboard will be available at: **http://localhost:3088**

## 📋 Features

- Real-time stdout/stderr streaming via WebSockets
- Dynamic swarm process management
- Token cost estimation
- Emergency stop functionality
- Context-based code generation
- Persistent session storage

## 📁 Project Structure

```
signal-zero-deployment/
├── server.ts           # Main Express + Socket.io server
├── package.json        # Dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── .gitignore          # Git ignore rules
└── README.md          # This file
```

## 🔌 API Endpoints

- `GET /` - Main dashboard UI
- `POST /api/start` - Start swarm process
- `POST /api/stop` - Stop active swarm process

## 📡 WebSocket Events

- `stdout` - Standard output stream
- `stderr` - Standard error stream
- `status` - Process status updates

## ⚙️ Configuration

Edit `server.ts` line with `const PORT = 3088;` to change the port.

## 🛠️ Build

```bash
npm run build
```

Outputs compiled JavaScript to `dist/` directory.

## 📝 License

MIT
