import type { SessionUser } from './lib/session';

export type AppEnv = {
  Bindings: Env;
  Variables: {
    /** Set by requireUser. */
    user: SessionUser;
  };
};
