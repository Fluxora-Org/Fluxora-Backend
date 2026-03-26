import express from 'express';
import { streamsRouter } from './routes/streams.js';
import { healthRouter } from './routes/health.js';
import { initializeConfig, getConfig, ConfigError } from './config/env.js';
import { initializeLogger, getLogger } from './config/logger.js';
import { HealthCheckManager, createDatabaseHealthChecker, createRedisHealthChecker, createHorizonHealthChecker } from './config/health.js';
import { createRequestSizeLimitMiddleware, createJsonDepthValidationMiddleware, createRequestTimeoutMiddleware, requestProtectionErrorHandler } from './middleware/requestProtection.js';
import { successResponse, errorResponse } from './utils/response.js';

/**
 * Initialize application with configuration and observability
 */
async function bootstrap() {
  try {
    // Load and validate configuration
    const config = initializeConfig();

    // Initialize logger
    const logger = initializeLogger(config.logLevel);
    logger.info('Configuration loaded', {
      environment: config.nodeEnv,
      port: config.port,
    });

    // Initialize health checks
    const healthManager = new HealthCheckManager();
    healthManager.registerChecker(createDatabaseHealthChecker());
    healthManager.registerChecker(createRedisHealthChecker());
    healthManager.registerChecker(createHorizonHealthChecker(config.horizonUrl));

    // Create Express app
    const app = express();

    // Request protection middleware (must be before express.json)
    app.use(createRequestSizeLimitMiddleware(config.maxRequestSizeBytes));

    // JSON parsing with configured size limit
    app.use(express.json({ limit: `${config.maxRequestSizeBytes}b` }));

    // JSON depth validation (must be after express.json)
    app.use(createJsonDepthValidationMiddleware(config.maxJsonDepth));

    // Request timeout protection
    app.use(createRequestTimeoutMiddleware(config.requestTimeoutMs));

    // Attach health manager to app for route access
    app.locals.healthManager = healthManager;
    app.locals.logger = logger;
    app.locals.config = config;

    // Log request protection configuration
    logger.info('Request protection enabled', {
      maxRequestSizeBytes: config.maxRequestSizeBytes,
      maxJsonDepth: config.maxJsonDepth,
      requestTimeoutMs: config.requestTimeoutMs,
    });

    logger.info('Stellar network configuration', {
      network: config.stellarNetwork,
      horizonUrl: config.horizonUrl,
      streamingContract: config.contractAddresses.streaming,
    });

    // Routes
    app.use('/health', healthRouter);
    app.use('/api/streams', streamsRouter);

    app.get('/', (_req, res) => {
      res.json(successResponse({
        name: 'Fluxora API',
        version: config.apiVersion,
        network: config.stellarNetwork,
        docs: 'Programmable treasury streaming on Stellar.',
      }));
    });

    // Error handler
    app.use(requestProtectionErrorHandler);
    app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error('Unhandled error', err);
      res.status(500).json(
        errorResponse(
          'Internal server error',
          'INTERNAL_ERROR',
          config.nodeEnv === 'development' ? err.message : undefined
        )
      );
    });

    // Start server
    app.listen(config.port, () => {
      logger.info(`Fluxora API listening on http://localhost:${config.port}`);
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration error: ${err.message}`);
      process.exit(1);
    }
    console.error('Failed to bootstrap application:', err);
    process.exit(1);
  }
}

bootstrap();
