type CorsRequest = {
  method: string;
  header: (name: string) => string | undefined;
};

type CorsResponse = {
  setHeader: (name: string, value: string) => void;
  sendStatus: (code: number) => void;
  status: (code: number) => {
    json: (body: unknown) => void;
  };
};

type CorsNext = (err?: unknown) => void;

const DEFAULT_ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type,Authorization,X-Correlation-ID';

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function allowOrigin(res: CorsResponse, origin: string): void {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', DEFAULT_ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', DEFAULT_ALLOWED_HEADERS);
}

function isPreflight(req: CorsRequest): boolean {
  return req.method === 'OPTIONS' && Boolean(req.header('Origin'));
}

export function corsAllowlistMiddleware(req: CorsRequest, res: CorsResponse, next: CorsNext): void {
  const origin = req.header('Origin');

  // Non-browser or same-origin requests do not carry Origin.
  if (!origin) {
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  if (!isProduction()) {
    allowOrigin(res, origin);
    if (isPreflight(req)) {
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const isAllowed = allowedOrigins.has(origin);

  if (isAllowed) {
    allowOrigin(res, origin);
    if (isPreflight(req)) {
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  if (isPreflight(req)) {
    res.status(403).json({
      error: {
        code: 'CORS_ORIGIN_DENIED',
        message: 'Origin is not allowed by CORS policy',
      },
    });
    return;
  }

  next();
}
