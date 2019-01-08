import fs from 'fs';
import path from 'path';
import http from 'http';

// @ts-ignore
import glob from '@now/build-utils/fs/glob';
import chalk from 'chalk';
import { send } from 'micro';

import wait from '../../util/output/wait';
import info from '../../util/output/info';
import error from '../../util/output/error';
import success from '../../util/output/success';
import { NowError } from '../../util/now-error';
import { readLocalConfig } from '../../util/config/files';

import builderCache from './builder-cache';

// temporally type
interface BuildConfig {
  src: string,
  use: string,
  config?: object
}

enum DevServerStatus { busy, idle }

type HttpHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => any;

export default class DevServer {
  private cwd: string;
  private server: http.Server;
  private status: DevServerStatus;
  private statusMessage = '';
  private builderDirectory = '';

  constructor (cwd: string, port = 3000) {
    this.cwd = cwd;
    this.server = http.createServer(this.devServerHandler);
    this.builderDirectory = builderCache.prepare();
    this.status = DevServerStatus.busy;
  }

  /* use dev-server as a "console" for logs. */
  logInfo (str: string) { console.log(info(str)) }
  logError (str: string) { console.log(error(str)) }
  logSuccess (str: string) { console.log(success(str))}
  logHttp (msg?: string) { msg && console.log(`\n  >>> ${msg}\n`) }

  start = async (port = 3000) => {
    const nowJson = readLocalConfig(this.cwd);

    return new Promise((resolve, reject) => {
      this.server.on('error', reject);

      this.server.listen(port, async () => {
        this.logSuccess(
          `dev server listning on port ${chalk.bold(String(port))}`
        );

        // Initial build, not meant to invoke, but for speed up further builds.
        if (nowJson && nowJson.builds) {
          try {
            this.setStatusBusy('installing builders');
            await this.installBuilders(nowJson.builds);

            this.setStatusBusy('building lambdas');
            await this.buildLambdas(nowJson.builds);
          } catch (err) {
            reject(err);
          }
        }

        this.setStatusIdle();
        resolve();
      });
    })
  }

  setStatusIdle = () => {
    this.status = DevServerStatus.idle;
    this.statusMessage = '';
  }

  setStatusBusy = (msg = '') => {
    this.status = DevServerStatus.busy;
    this.statusMessage = msg;
  }

  devServerHandler:HttpHandler = async (req, res) => {
    if (this.status === DevServerStatus.busy) {
      return res.end(`[busy] ${this.statusMessage}...`);
    }

    if (!req.url) return

    const reqPath = req.url.replace(/^\//, '');

    if (reqPath === 'favicon.ico') {
      return res.end('');
    }

    const nowJson = readLocalConfig(this.cwd);

    if (nowJson === null) {
      // serve source as static
      // TODO: honor gitignore & nowignore
      const dest = path.join(this.cwd, reqPath);

      if (fs.lstatSync(dest).isFile()) {
        return send(res, 200, fs.createReadStream(dest));
      }

      return send(res, 404);
    }

    if (nowJson) {
      let assets = [];

      if (nowJson.builds) {
        assets = await this.buildUserProject(nowJson.builds);
      }

      if (nowJson.routes) {
        const dest = nowJson.routes.reduce((accu: string, curr: any) => {

        }, reqPath);
      }

      console.log(12, assets, reqPath);

      // if (assets.includes(reqPath)) {
      //   this.handleRequest(req, res, )
      // }
    }

    this.logHttp(req.url);
    res.end('TODO: rebuild & invoke lambda.');
    this.setStatusIdle();
  }

  buildUserProject = async (buildsConfig: BuildConfig[]) => {
    try {
      this.setStatusBusy('installing builders');
      await this.installBuilders(buildsConfig);

      this.setStatusBusy('building lambdas');
      const assets = await this.buildLambdas(buildsConfig);

      this.setStatusIdle();
      return assets;
    } catch (err) {
      throw new Error('Build failed.');
    }
  }

  installBuilders = async (buildsConfig: BuildConfig[]) => {
    const builders = buildsConfig
      .map(build => build.use)
      .filter(pkg => pkg !== '@now/static')
      .concat('@now/build-utils');

    for (const builder of builders) {
      const stopSpinner = wait(`pulling ${builder}`);
      await builderCache.install(this.builderDirectory, builder);
      stopSpinner();
    }
  }

  buildLambdas = async (buildsConfig: BuildConfig[]) => {
    const files = await glob('**', this.cwd);
    const results = [];

    for (const build of buildsConfig) {
      try {
        console.log(`> build ${JSON.stringify(build)}`);
        const builder = builderCache.get(this.builderDirectory, build.use);
        const entries = Object.values(await glob(build.src, this.cwd));

        // TODO: hide those build logs from console.
        for (const entry of entries) {
          const output = await builder.build({
            files,
            // @ts-ignore: handle this warning later.
            entrypoint: path.relative(this.cwd, entry.fsPath),
            workPath: this.cwd,
            config: build.config
          });
          results.push(output);
        }
      } catch (err) {
        throw new NowError({
          code: 'NOW_BUILDER_FAILURE',
          message: `Failed building ${chalk.bold(build.src)} with ${build.use}`,
          meta: err.stack
        });
      }
    }

    return results;
  }
}