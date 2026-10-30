import { onRequest } from './functions/api/[[route]].js';

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api')) {
            return onRequest({
                request,
                env,
                waitUntil: ctx && ctx.waitUntil ? ctx.waitUntil.bind(ctx) : () => {}
            });
        }
        return env.ASSETS.fetch(request);
    }
};
