import { CanaryActionError } from '../src/errors';
import { expect, test } from '@jest/globals';

// Removed ArtifactUploadFailedError test - error is unused

test('CanaryActionError sets code correctly', () => {
  const error = new CanaryActionError('TestError', 'Test message');
  expect(error.code).toBe('TestError');
  expect(error.message).toBe('Test message');
});