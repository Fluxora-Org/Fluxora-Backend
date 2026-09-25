/**
 * SQL identifier allowlisting.
 *
 * PostgreSQL parameters can represent values, but not identifiers such as
 * column names or sort directions. Any identifier that is allowed to affect
 * query construction must therefore be selected from a closed, compile-time
 * allowlist before it is interpolated into SQL.
 */

export class InvalidSqlIdentifierError extends Error {
  constructor(identifier: string, kind = 'SQL identifier') {
    super(`Invalid ${kind}: ${identifier}`);
    this.name = 'InvalidSqlIdentifierError';
  }
}

export function allowlistedSqlIdentifier<T extends string>(
  value: string,
  allowlist: Readonly<Record<T, string>>,
  kind = 'SQL identifier'
): string {
  const selected = allowlist[value as T];
  if (selected === undefined) {
    throw new InvalidSqlIdentifierError(value, kind);
  }
  return selected;
}

export const STREAM_CURSOR_SORT_FIELDS = {
  id: 'id',
} as const;

export const STREAM_OFFSET_SORT_FIELDS = {
  created_at: 'created_at DESC, id DESC',
  id: 'id DESC',
} as const;

export const SORT_DIRECTIONS = {
  asc: 'ASC',
  desc: 'DESC',
} as const;

/**
 * Maximum byte length of a PostgreSQL identifier (NAMEDATALEN - 1).
 */
export const MAX_SQL_IDENTIFIER_LENGTH = 63;

/**
 * Validates that an identifier is well-formed for PostgreSQL.
 *
 * Rejects:
 * - Non-string, empty, or whitespace-only inputs
 * - Identifiers exceeding 63 bytes in UTF-8 representation
 * - Identifiers containing null bytes (\0)
 * - Identifiers containing ASCII control characters (\u0000-\u001f, \u007f-\u009f)
 * - Identifiers containing SQL statement terminators or comment markers (; , -- , /* , *\/)
 * - Identifiers containing SQL string delimiters (') or backslashes (\)
 */
export function isValidSqlIdentifier(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.trim().length === 0) {
    return false;
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_SQL_IDENTIFIER_LENGTH) {
    return false;
  }
  if (name.includes('\0')) {
    return false;
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return false;
  }
  if (/;|--|\/\*|\*\/|'|\\/.test(name)) {
    return false;
  }
  return true;
}

/**
 * Safely quotes a PostgreSQL identifier (table or column name).
 *
 * Verifies that the identifier is well-formed, escapes embedded double quotes
 * by doubling them per the SQL standard, and wraps the identifier in double quotes.
 *
 * Throws InvalidSqlIdentifierError if the identifier is not well-formed.
 */
export function quoteIdentifier(name: string): string {
  if (!isValidSqlIdentifier(name)) {
    throw new InvalidSqlIdentifierError(String(name), 'SQL identifier');
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export interface SqlIdentifierViolation {
  file: string;
  line: number;
  column: number;
  snippet: string;
  message: string;
}

/**
 * Internal AST scanner for detecting direct identifier interpolations in SQL queries.
 */
export function scanSourceForIdentifierInterpolations(
  ts: typeof import('typescript'),
  sourceCode: string,
  fileName: string,
): SqlIdentifierViolation[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
  );

  const violations: SqlIdentifierViolation[] = [];
  const safeIdentifierVars = new Set<string>();

  function collectSafeVars(node: import('typescript').Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isCallExpression(node.initializer)) {
        const callee = node.initializer.expression;
        if (ts.isIdentifier(callee)) {
          if (callee.text === 'quoteIdentifier' || callee.text === 'allowlistedSqlIdentifier') {
            safeIdentifierVars.add(node.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collectSafeVars);
  }

  collectSafeVars(sourceFile);

  function isSqlTemplate(text: string): boolean {
    const upper = text.toUpperCase();
    return (
      upper.includes('SELECT ') ||
      upper.includes('INSERT INTO') ||
      upper.includes('UPDATE ') ||
      upper.includes('DELETE FROM') ||
      upper.includes('CREATE TABLE') ||
      upper.includes('ALTER TABLE') ||
      upper.includes('DROP TABLE') ||
      upper.includes('TRUNCATE ') ||
      upper.includes('FROM ') ||
      upper.includes('WHERE ')
    );
  }

  const TABLE_OR_SORT_IDENTIFIER_POSITION = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE|ORDER\s+BY|GROUP\s+BY)\s*$/i;
  const COLUMN_POSITION_BEFORE_REGEX = /(?:SELECT(?:\s+DISTINCT)?|,)\s*$/i;
  const IDENTIFIER_NAME_PATTERN = /^(?:table|tableName|targetTable|entityTable|column|col|colName|columnName|field|fieldName|sortField|sortColumn|sortClause|orderBy|cursorSort|offsetSort)$/i;

  function visit(node: import('typescript').Node) {
    if (ts.isTemplateExpression(node)) {
      const fullTemplateText = node.getText(sourceFile);
      if (isSqlTemplate(fullTemplateText)) {
        let prevText = node.head.text;

        for (let i = 0; i < node.templateSpans.length; i++) {
          const span = node.templateSpans[i]!;
          const expr = span.expression;
          const exprText = expr.getText(sourceFile).trim();

          const isParamIndex = prevText.endsWith('$');

          if (!isParamIndex) {
            const isClauseOrHelper =
              exprText.includes('.join(') ||
              /^(?:where|whereClause|whereBase|candidateQuery|tenantClause|SELECT_COLUMNS)$/i.test(exprText) ||
              exprText.startsWith('streamSelectColumns(') ||
              exprText.startsWith('encryptAddressValue(') ||
              exprText.startsWith('senderAddressFilterCondition(') ||
              exprText.startsWith('recipientAddressFilterCondition(');

            if (!isClauseOrHelper) {
              const isTableOrSortPos = TABLE_OR_SORT_IDENTIFIER_POSITION.test(prevText);
              const isColumnPos =
                COLUMN_POSITION_BEFORE_REGEX.test(prevText) &&
                span.literal.text.toUpperCase().includes('FROM');
              const isIdentifierNamed = IDENTIFIER_NAME_PATTERN.test(exprText);

              if (isTableOrSortPos || isColumnPos || isIdentifierNamed) {
                let isSafe = false;

                if (ts.isCallExpression(expr)) {
                  const callee = expr.expression;
                  if (ts.isIdentifier(callee)) {
                    if (callee.text === 'quoteIdentifier' || callee.text === 'allowlistedSqlIdentifier') {
                      isSafe = true;
                    }
                  }
                } else if (ts.isIdentifier(expr)) {
                  if (safeIdentifierVars.has(expr.text)) {
                    isSafe = true;
                  }
                }

                if (!isSafe) {
                  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
                    expr.getStart(sourceFile),
                  );
                  violations.push({
                    file: fileName,
                    line: line + 1,
                    column: character + 1,
                    snippet: exprText,
                    message: `Direct SQL identifier interpolation detected: "${exprText}". Identifiers must pass through quoteIdentifier() or allowlistedSqlIdentifier() from sqlIdentifiers.ts.`,
                  });
                }
              }
            }
          }

          prevText = span.literal.text;
        }
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (ts.isStringLiteral(node.left) || ts.isNoSubstitutionTemplateLiteral(node.left)) {
        const leftText = node.left.text;
        const right = node.right;
        const rightText = right.getText(sourceFile).trim();
        if (
          TABLE_OR_SORT_IDENTIFIER_POSITION.test(leftText) ||
          COLUMN_POSITION_BEFORE_REGEX.test(leftText) ||
          IDENTIFIER_NAME_PATTERN.test(rightText)
        ) {
          let isSafe = false;
          if (ts.isCallExpression(right)) {
            const callee = right.expression;
            if (
              ts.isIdentifier(callee) &&
              (callee.text === 'quoteIdentifier' || callee.text === 'allowlistedSqlIdentifier')
            ) {
              isSafe = true;
            }
          } else if (ts.isIdentifier(right) && safeIdentifierVars.has(right.text)) {
            isSafe = true;
          }
          if (!isSafe) {
            const { line, character } = sourceFile.getLineAndCharacterOfPosition(
              right.getStart(sourceFile),
            );
            violations.push({
              file: fileName,
              line: line + 1,
              column: character + 1,
              snippet: rightText,
              message: `Direct SQL identifier concatenation detected: "${rightText}". Identifiers must pass through quoteIdentifier() or allowlistedSqlIdentifier() from sqlIdentifiers.ts.`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/**
 * Asserts that the provided TypeScript source code contains no direct SQL identifier interpolations.
 */
export async function assertNoDirectIdentifierInterpolation(
  sourceCode: string,
  fileName = 'anonymous.ts',
): Promise<SqlIdentifierViolation[]> {
  const tsModule = await import('typescript');
  const tsInstance = (tsModule as unknown as { default?: typeof import('typescript') }).default ?? tsModule;
  return scanSourceForIdentifierInterpolations(tsInstance, sourceCode, fileName);
}

/**
 * Checks all repository files in src/db/repositories to assert that sqlIdentifiers.ts
 * is the only path by which identifiers reach SQL.
 */
export async function checkRepositoriesForDirectInterpolation(
  repositoryDir?: string,
): Promise<{ valid: boolean; violations: SqlIdentifierViolation[]; filesChecked: string[] }> {
  const [tsModule, fs, path] = await Promise.all([
    import('typescript'),
    import('fs'),
    import('path'),
  ]);

  const tsInstance = (tsModule as unknown as { default?: typeof import('typescript') }).default ?? tsModule;
  const dir = repositoryDir ?? path.resolve(process.cwd(), 'src/db/repositories');
  const files = fs
    .readdirSync(dir)
    .filter((f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'sqlIdentifiers.ts');

  const violations: SqlIdentifierViolation[] = [];
  const filesChecked: string[] = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    filesChecked.push(fullPath);
    const content = fs.readFileSync(fullPath, 'utf8');
    const fileViolations = scanSourceForIdentifierInterpolations(tsInstance, content, file);
    violations.push(...fileViolations);
  }

  return {
    valid: violations.length === 0,
    violations,
    filesChecked,
  };
}
