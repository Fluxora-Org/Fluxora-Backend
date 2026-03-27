// Quick test to verify imports work
import('./dist/config/env.js').then(() => {
  console.log('✓ env module loads');
}).catch(err => {
  console.error('✗ env module error:', err.message);
});
