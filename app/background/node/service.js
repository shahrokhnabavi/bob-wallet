import pify from '../../utils/pify';
import { app, BrowserWindow } from 'electron';
import { VALID_NETWORKS } from '../../constants/networks';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import tcpPortUsed from 'tcp-port-used';
import EventEmitter from 'events';
import { NodeClient } from 'hs-client';
import { BigNumber } from 'bignumber.js';
import {ConnectionTypes, getConnection, getCustomRPC} from '../connections/service';

const Network = require('hsd/lib/protocol/network');

const MIN_FEE = new BigNumber(0.01);
const DEFAULT_BLOCK_TIME = 10 * 60 * 1000;

export class NodeService extends EventEmitter {
  constructor() {
    super();

    this.hsdPrefixDir = path.join(app.getPath('userData'), 'hsd_data');
  }

  async configurePaths() {
    if (!fs.existsSync(this.hsdPrefixDir)) {
      await pify(cb => fs.mkdir(this.hsdPrefixDir, {recursive: true}, cb));
    }
  }

  async start(networkName) {
    const conn = await getConnection();

    switch (conn.type) {
      case ConnectionTypes.P2P:
        await this.startNode(networkName);
        return;
      case ConnectionTypes.Custom:
        await this.startCustom();
        return;
    }
  }

  async startNode(networkName) {
    if (this.hsdWindow && this.networkName === networkName) {
      return;
    }
    if (this.hsdWindow) {
      throw new Error('hsd already started.');
    }
    if (!VALID_NETWORKS[networkName]) {
      throw new Error('Invalid network.');
    }

    const network = Network.get(networkName);
    const apiKey = crypto.randomBytes(20).toString('hex');

    this.networkName = networkName;
    this.network = network;
    this.apiKey = apiKey;
    this.emit('started', this.networkName, this.network, this.apiKey);

    const portsFree = await checkHSDPortsFree(network);
    if (!portsFree) {
      throw new Error('hsd ports in use. Please make sure no other hsd instance is running, quit Bob, and try again.');
    }

    console.log(`Starting node on ${networkName} network.`);
    const hsdWindow = new BrowserWindow({
      width: 400,
      height: 400,
      show: false,
      webPreferences: {
        nodeIntegration: true,
      },
    });

    await hsdWindow.loadURL(`file://${path.join(__dirname, '../../hsd.html')}`);
    hsdWindow.webContents.send('start', this.hsdPrefixDir, networkName, apiKey);
    await new Promise((resolve, reject) => {
      const lis = (_, channel, ...args) => {
        if (channel !== 'started' && channel !== 'error') {
          return;
        }

        hsdWindow.webContents.removeListener('started', lis);
        hsdWindow.webContents.removeListener('error', lis);

        if (channel === 'error') {
          console.error('Error opening hsd window:', args);
          return reject(args[0]);
        }

        resolve();
      };
      hsdWindow.webContents.on('ipc-message', lis);
    });
    hsdWindow.on('closed', () => {
      console.log('hsd window closed.');
      this.emit('stopped');
      this.hsdWindow = null;
    });

    const client = new NodeClient({
      network: network,
      port: network.rpcPort,
      apiKey,
    });
    await retry(() => client.getInfo(), 20, 200);


    this.hsdWindow = hsdWindow;
    this.client = client;
  }

  async startCustom() {
    const rpc = await getCustomRPC();
    const networkType = rpc.networkType || 'main';

    if (!VALID_NETWORKS[networkType]) {
      throw new Error('Invalid network.');
    }

    const network = Network.get(networkType);
    this.networkName = networkType;
    this.network = network;
    this.emit('started', this.networkName, this.network);

    const client = new NodeClient({
      network: network,
      apiKey: rpc.apiKey,
      url: rpc.url || `http://127.0.0.1:${network.rpcPort}`,
    });

    this.client = client;
  }

  async stop() {
    if (!this.hsdWindow) {
      this.emit('stopped');
      return;
    }

    const closed = new Promise((resolve) => this.hsdWindow.on('closed', resolve));
    this.hsdWindow.send('close');
    await closed;
    this.hsdWindow = null;
    this.client = null;
  }

  async reset() {
    await this.stop();
    await this.start(this.networkName);
  }

  async getAPIKey() {
    await this._ensureStarted();
    return this.apiKey;
  }

  async getInfo() {
    await this._ensureStarted();
    return this.client.getInfo();
  }

  async getTXByAddresses(addresses) {
    await this._ensureStarted();
    return this.client.getTXByAddresses(addresses);
  }

  async getNameInfo(name) {
    return this._execRPC('getnameinfo', [name]);
  }

  async getNameByHash(hash) {
    return this._execRPC('getnamebyhash', [hash]);
  }

  async getAuctionInfo(name) {
    return this._execRPC('getauctioninfo', [name]);
  }

  async getBlock(height) {
    return this.client.getBlock(height);
  }

  async getBlockByHeight(height, verbose, details) {
    return this._execRPC('getblockbyheight', [height, verbose ? 1 : 0, details ? 1 : 0]);
  }

  async getTx(hash) {
    this._ensureStarted();
    return this.client.getTX(hash);
  }

  async broadcastRawTx(tx) {
    return this._execRPC('sendrawtransaction', [tx]);
  }

  async sendRawAirdrop(data) {
    return this._execRPC('sendrawairdrop', [data]);
  }

  async getFees() {
    await this._ensureStarted();
    const slowRes = await this.client.execute('estimatesmartfee', [5]);
    const standardRes = await this.client.execute('estimatesmartfee', [2]);
    const fastRes = await this.client.execute('estimatesmartfee', [1]);
    const slow = BigNumber.max(new BigNumber(slowRes.fee), MIN_FEE).toFixed(6);
    const standard = BigNumber.max(new BigNumber(standardRes.fee), MIN_FEE * 5).toFixed(6);
    const fast = BigNumber.max(new BigNumber(fastRes.fee), MIN_FEE * 10).toFixed(6);

    return {
      slow,
      standard,
      fast,
    };
  }

  async getAverageBlockTime() {
    await this._ensureStarted();

    const info = await this.client.getInfo();
    const height = info.chain.height;
    if (height <= 1) {
      return DEFAULT_BLOCK_TIME;
    }

    const averageOver = 50;
    const startHeight = Math.max(height - averageOver, 1);
    let previous = 0;
    let count = 0;
    let sum = 0;
    for (let i = startHeight; i <= height; i++) {
      const block = await this.client.execute('getblockbyheight', [i, true, false]);
      if (previous === 0) {
        previous = block.time;
        continue;
      }

      count++;
      sum += (block.time - previous);
      previous = block.time;
    }

    return Math.floor((sum / count) * 1000);
  }

  async _ensureStarted() {
    return new Promise((resolve, reject) => {
      if (this.client) {
        resolve();
        return;
      }

      setTimeout(async () => {
        await this._ensureStarted();
        resolve();
      }, 500);
    });
  }

  async _execRPC(method, args) {
    await this._ensureStarted();
    return this.client.execute(method, args);
  }
}

async function checkHSDPortsFree(network) {
  const ports = [
    network.port,
    network.rpcPort,
    // network.walletPort,
    network.nsPort,
  ];

  for (const port of ports) {
    const inUse = await tcpPortUsed.check(port);
    if (inUse) {
      return false;
    }
  }

  return true;
}

async function retry(action, attempts = 10, interval = 200) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await action();
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  console.error('Last err in retry:', lastErr);
  throw new Error('timed out');
}

export const service = new NodeService();

const sName = 'Node';
const methods = {
  start: (networkName) => service.start(networkName),
  stop: () => service.stop(),
  reset: () => service.reset(),
  getAPIKey: () => service.getAPIKey(),
  getInfo: () => service.getInfo(),
  getNameInfo: (name) => service.getNameInfo(name),
  getNameByHash: (hash) => service.getNameByHash(hash),
  getAuctionInfo: (name) => service.getAuctionInfo(name),
  getBlock: (height) => service.getBlock(height),
  getTXByAddresses: (addresses) => service.getTXByAddresses(addresses),
  getBlockByHeight: (height, verbose, details) => service.getBlockByHeight(height, verbose, details),
  getTx: (hash) => service.getTx(hash),
  broadcastRawTx: (tx) => service.broadcastRawTx(tx),
  sendRawAirdrop: (data) => service.sendRawAirdrop(data),
  getFees: () => service.getFees(),
  getAverageBlockTime: () => service.getAverageBlockTime(),
};

export async function start(server) {
  await service.configurePaths();
  server.withService(sName, methods);
}
