const express = require('express');
const { createCanaryRoutingMiddleware } = require('../../src/middleware/canaryRouting');
const { correlationIdMiddleware } = require('../../src/middleware/correlationId');

const app = express();
app.use(correlationIdMiddleware);
app.use(createCanaryRoutingMiddleware({ trafficPercent: 10, salt: 'test-salt' }));

app.get('/test', (req, res) => {
  res.json({ isCanary: req.isCanary });
});

app.listen(3000, () => {
  console.log('Test server running on port 3000');
});
