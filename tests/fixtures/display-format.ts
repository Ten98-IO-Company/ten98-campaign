// Many UI tests call a component as a plain function with stubbed hooks, where React has no dispatcher and
// useDisplayFormat cannot read its context. These scopes give that hook the formatter it returns without a provider
// (English, UTC), so rendered dates and numbers match what renderToStaticMarkup produces.
import * as ui from '@ten98/ui';

export const format = ui.createDisplayFormatter({ locale: 'en', timeZone: 'UTC' });
/** @ten98/ui with useDisplayFormat replaced by a plain function; spread it wherever a test spreads the library. */
export const hooklessUi: typeof ui = { ...ui, useDisplayFormat: () => format };
