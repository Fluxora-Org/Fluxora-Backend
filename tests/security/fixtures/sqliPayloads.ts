export const sqliPayloads = [
  "' OR '1'='1",
  "; DROP TABLE streams; --",
  "UNION SELECT password FROM users --",
  "' OR 1=1 LIMIT 1; --",
  "'; EXEC xp_cmdshell('dir'); --",
  '"; SELECT * FROM pg_catalog.pg_tables; --',
  "') OR ('1'='1",
  "-- comment",
  "\\'; WAITFOR DELAY '00:00:05'--",
];
