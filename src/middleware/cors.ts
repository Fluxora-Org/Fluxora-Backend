type CorsRequest = {
  method: string;
  header: (name: string) => string | undefined;
};

type CorsResponse = {
  setHeader: (name: string, value: string) => void;
  removeHeader: (name: string) => void;
  sendStatus: (code: number) => void;
  status: (code: number) => {
    json: (body: unknown) => void;
  };
};

type CorsNext = (err?: unknown) => void;

const DEFAULT_ALLOWED_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type,Authorization,X-Correlation-ID';
const CORS_PERMISSION_HEADERS = [
  'Access-Control-Allow-Origin',
  'Access-Control-Allow-Credentials',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Access-Control-Max-Age',
];
const PREFLIGHT_MAX_AGE = '86400'; // 24 hours in seconds

export function isOriginAllowed(origin: string, allowedOrigins: Set<string>): boolean {
  return origin !== 'null' && !origin.includes('*') && allowedOrigins.has(origin);
}

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function clearCorsPermissionHeaders(res: CorsResponse): void {
  for (const header of CORS_PERMISSION_HEADERS) {
    res.removeHeader(header);
  }
}

function allowOrigin(
  req: CorsRequest,
  res: CorsResponse,
  origin: string,
  useWildcard: boolean
): void {
  clearCorsPermissionHeaders(res);
  if (useWildcard) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', DEFAULT_ALLOWED_METHODS);

  // Echo back the requested headers if present, otherwise use defaults.
  const requestedHeaders = req.header('Access-Control-Request-Headers');
  res.setHeader('Access-Control-Allow-Headers', requestedHeaders ?? DEFAULT_ALLOWED_HEADERS);
}

function isPreflight(req: CorsRequest): boolean {
  return req.method === 'OPTIONS' && Boolean(req.header('Origin'));
}

export function corsAllowlistMiddleware(req: CorsRequest, res: CorsResponse, next: CorsNext): void {
  const origin = req.header('Origin');

  // Non-browser or same-origin requests do not carry Origin.
  if (!origin) {
    clearCorsPermissionHeaders(res);
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const allowAnyOrigin = !isProduction() && (allowedOrigins.size === 0 || allowedOrigins.has('*'));
  const isAllowed = allowAnyOrigin || isOriginAllowed(origin, allowedOrigins);

  if (isAllowed) {
    allowOrigin(req, res, origin, allowAnyOrigin);
    if (isPreflight(req)) {
      res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE);
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  clearCorsPermissionHeaders(res);
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
