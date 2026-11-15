// Test-only stand-in for useDisplayFormat. These tests call components as plain functions, outside a React render, where
// useContext cannot run; the stand-in returns the formatter a component gets without a provider (English, UTC).
import { createDisplayFormatter } from '@ten98/ui';

export const testDisplayFormat = createDisplayFormatter({ locale: 'en', timeZone: 'UTC' });
export const useTestDisplayFormat = () => testDisplayFormat;
// The @ten98/ui exports with useDisplayFormat replaced, for tests that inject the library into evaluated source.
export const withTestDisplayFormat = <T extends object>(library: T): T => ({ ...library, useDisplayFormat: useTestDisplayFormat });
