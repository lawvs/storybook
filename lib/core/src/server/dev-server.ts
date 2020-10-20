import path from 'path';
import { Router } from 'express';
import webpack from 'webpack';

import webpackDevMiddleware from 'webpack-dev-middleware';
import webpackHotMiddleware from 'webpack-hot-middleware';

import { logger } from '@storybook/node-logger';
import { getMiddleware } from './utils/middleware';
import { logConfig } from './logConfig';
import loadConfig from './config';
import loadManagerConfig from './manager/manager-config';
import { resolvePathInStorybookCache } from './utils/resolve-path-in-sb-cache';

const dllPath = path.join(__dirname, '../../dll');

const cache = {};

let previewProcess: any;
let previewReject: Function;
let resolved = false;

// @ts-ignore
const router: Router = new Router();

export default function (options: any) {
  const configDir = path.resolve(options.configDir);
  const outputDir = options.smokeTest
    ? resolvePathInStorybookCache('public')
    : path.resolve(options.outputDir || resolvePathInStorybookCache('public'));
  const configType = 'DEVELOPMENT';

  const startTime = process.hrtime();
  let managerTotalTime: [number, number];
  let previewTotalTime: [number, number];

  const managerPromise = loadManagerConfig({
    configType,
    outputDir,
    configDir,
    cache,
    corePresets: [require.resolve('./manager/manager-preset.js')],
    ...options,
  }).then((config) => {
    if (options.debugWebpack) {
      // @ts-ignore
      logConfig('Manager webpack config', config, logger);
    }
    const managerCompiler = webpack(config);

    const devMiddlewareOptions = {
      publicPath: config.output.publicPath,
      writeToDisk: !!options.smokeTest,
      watchOptions: {
        aggregateTimeout: 2000,
        ignored: /node_modules/,
      },
      // this actually causes 0 (regular) output from wdm & webpack
      logLevel: 'warn',
      clientLogLevel: 'warning',
      noInfo: true,
    } as const;

    const managerDevMiddlewareInstance = webpackDevMiddleware(
      managerCompiler,
      devMiddlewareOptions
    );

    router.get(/\/static\/media\/.*\..*/, (request: any, response: any, next: Function) => {
      response.set('Cache-Control', `public, max-age=31536000`);
      next();
    });

    router.use(managerDevMiddlewareInstance);

    return new Promise((resolve, reject) => {
      managerDevMiddlewareInstance.waitUntilValid((stats: any) => {
        managerTotalTime = process.hrtime(startTime);

        if (!stats) {
          reject(new Error('no stats after building preview'));
        } else if (stats.hasErrors()) {
          reject(stats);
        } else {
          resolve(stats);
        }
      });
    });
  });

  const previewPromise = options.ignorePreview
    ? new Promise((resolve) => resolve())
    : loadConfig({
        configType,
        outputDir,
        cache,
        corePresets: [require.resolve('./preview/preview-preset.js')],
        overridePresets: [require.resolve('./preview/custom-webpack-preset.js')],
        ...options,
      }).then((previewConfig) => {
        if (options.debugWebpack) {
          // @ts-ignore
          logConfig('Preview webpack config', previewConfig, logger);
        }

        // remove the leading '/'
        let { publicPath } = previewConfig.output;
        if (publicPath[0] === '/') {
          publicPath = publicPath.slice(1);
        }

        const previewCompiler = webpack(previewConfig);

        const devMiddlewareOptions = {
          publicPath: previewConfig.output.publicPath,
          watchOptions: {
            aggregateTimeout: 1,
            ignored: /node_modules/,
            ...(previewConfig.watchOptions || {}),
          },
          // this actually causes 0 (regular) output from wdm & webpack
          logLevel: 'warn',
          clientLogLevel: 'warning',
          noInfo: true,
          ...previewConfig.devServer,
        };

        const previewDevMiddlewareInstance = webpackDevMiddleware(
          previewCompiler,
          devMiddlewareOptions
        );

        router.use(previewDevMiddlewareInstance);
        router.use(webpackHotMiddleware(previewCompiler));

        return new Promise((resolve, reject) => {
          previewReject = reject;
          previewDevMiddlewareInstance.waitUntilValid((stats: any) => {
            resolved = true;
            previewTotalTime = process.hrtime(startTime);

            if (!stats) {
              reject(new Error('no stats after building preview'));
            } else if (stats.hasErrors()) {
              reject(stats);
            } else {
              resolve(stats);
            }
          });
          previewProcess = previewDevMiddlewareInstance;
        });
      });

  // custom middleware
  const middlewareFn = getMiddleware(configDir);
  middlewareFn(router);

  managerPromise.catch((e) => {
    try {
      if (!resolved) {
        previewReject();
      }
      previewProcess.close();
      logger.warn('force closed preview build');
    } catch (err) {
      logger.warn('Unable to close preview build!');
    }
  });

  return Promise.all([managerPromise, previewPromise]).then(([managerStats, previewStats]) => {
    router.get('/', (request, response) => {
      response.set('Content-Type', 'text/html');
      response.sendFile(path.join(`${outputDir}/index.html`));
    });
    router.get(/\/sb_dll\/(.+\.js)$/, (request, response) => {
      response.set('Content-Type', 'text/javascript');
      response.sendFile(path.join(`${dllPath}/${request.params[0]}`));
    });
    router.get(/\/sb_dll\/(.+\.LICENCE)$/, (request, response) => {
      response.set('Content-Type', 'text/html');
      response.sendFile(path.join(`${dllPath}/${request.params[0]}`));
    });

    return { previewStats, managerStats, managerTotalTime, previewTotalTime, router };
  });
}
