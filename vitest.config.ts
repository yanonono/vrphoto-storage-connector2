import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(() => {
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        remoteBindings: false,
        miniflare: {
          bindings: {
            CONNECTOR_ID: 'test-connector',
            VRPHOTO_PUBLIC_KEY_JWK:
              '{"key_ops":["verify"],"ext":true,"crv":"Ed25519","x":"4BOz5zs9V_iL-k-JOjEmr7TvYJHYFXyWC-g67YXn2bQ","kty":"OKP"}',
            ALLOWED_ORIGIN: 'https://vrphoto.example.test',
            SITE_PAIRING_ENDPOINT: '',
          },
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
