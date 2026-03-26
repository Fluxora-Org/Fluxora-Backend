/**
 * Fluxora Backend Server
 * 
 * Purpose: Off-chain companion to the streaming contract presenting a trustworthy,
 * operator-grade HTTP surface for discovery and automation.
 * 
 * Key Guarantees:
 * - Amounts crossing the chain/API boundary are serialized as decimal strings
 * - All errors are classified and logged for diagnostics
 * - Health endpoints for operational monitoring
 * 
 * @module index
 */

import express, { Request, Response, NextFunction } from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestIdMiddleware, info, warn } from './utils/logger.js';

const PORT = process.env.PORT ?? 3000;

// Trust boundary: Add request ID for tracing
app.use(requestIdMiddleware);

// Trust boundary: Parse JSON with size limits
app.use(express.json({ limit: '1mb' }));

// Trust boundary: Log all requests
app.use((req: Request, _res: Response, next: NextFunction) => {
  const requestId = (req as Request & { id?: string }).id;
  info('Incoming request', {
    method: req.method,
    path: req.path,
    requestId,
  });
  next();
});

// Mount health router for operational monitoring
// Public: Anyone can check health (trust boundary: read-only)
app.use('/health', healthRouter);

// Mount streams router for stream management
// Note: In production, this should be protected by authentication
app.use('/api/streams', streamsRouter);

// Root endpoint with API documentation
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Fluxora API',
    version: '0.1.0',
    description: 'Programmable treasury streaming on Stellar.',
    documentation: {
      openapi: '/api/streams (see source for OpenAPI spec)',
      health: '/health',
    },
    decimalPolicy: {
      description: 'All amount fields are serialized as decimal strings',
      fields: ['depositAmount', 'ratePerSecond'],
      format: '^[+-]?\\d+(\\.\\d+)?$',
    },
  });
});

// Trust boundary: 404 handler for unknown routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found',
    },
  });
});

// Global error handler (must be last)
// Catches all errors and returns consistent JSON responses
// Trust boundary: Never exposes internal error details in production
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestId = (req as Request & { id?: string }).id;
  
  // Handle JSON parsing errors
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON in request body',
        requestId,
      },
    });
    return;
  }
  
  errorHandler(err, req, res, _next);
});

// Start server
const server = app.listen(PORT, () => {
  info(`Fluxora API listening on http://localhost:${PORT}`);
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  warn('SIGTERM received, shutting down gracefully');
  server.close(() => {
    info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  warn('SIGINT received, shutting down gracefully');
  server.close(() => {
    info('Server closed');
    process.exit(0);
  });
});

export { app };
