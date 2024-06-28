/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientOptions } from '../Client';
import Cluster, { Worker } from 'cluster';
import { IPCMessage, IResult } from '../classes/IPCMessage';
import { ClusterClient } from './ClusterClient';
import { ClusterEvents } from '../events/ClusterEvents';
import { Collection } from '../classes/Collection';

export interface ClusterManagerOptions extends ClientOptions {
  clustering: {
    totalWorkers?: number;
  }
}

export class ClusterManager extends Collection<Worker> {
  #token: string;
  public options: Partial<ClusterManagerOptions>;
  public events: ClusterEvents;

  public constructor(token: string, options: Partial<ClusterManagerOptions>) {
    super();
    this.#token = token;
    this.options = options;
    this.events = new ClusterEvents();
  }

  public async init(): Promise<this> {
    if (Cluster.isPrimary) {
      const chunks = [];
      const shards = [];
      const sep = (this.options.sharding?.totalShards || 2) / (this.options.clustering?.totalWorkers || 1);

      for (let i = 0; i < (this.options.sharding?.totalShards || 2); i++) {
        shards.push(i);
      }

      for (let i = 0; i < shards.length; i += sep) {
        const chunk = shards.slice(i, i + sep);
        if (chunk.length) chunks.push(chunk);
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) break;

        const worker = Cluster.fork();
        worker.setMaxListeners(9999);
        super.set(worker.process.pid, worker);

        worker.send({ index: i, token: this.#token, shards: chunk, total: this.options.sharding?.totalShards || 2, event: 'master-initial' });
        
        worker.on('exit', () => {
          console.log('exit');
          this.events.workerExit.notify(worker);

          super.delete(worker.process.pid);
          console.log('ei');
        });

        worker.on('message', (message) => {
          const msg = new IPCMessage(message);
          if (!msg) return;

          const sender = super.get(worker.process.pid);
          if (!sender || !sender.process.pid) return;

          switch (msg.event) {
          case 'broadcast-request': {
            let reqsSent = 0;
            const result: IResult[] = [];
            const cid = IPCMessage.generateCID();

            for (const worker of super.toArray()) {
              worker.send(new IPCMessage({ from: 'master', to: worker.process.pid, event: 'data-request', cid, data: msg.data }));
              reqsSent++;

              const callback = (message: any) => {
                const response = new IPCMessage(message);
                if (response.cid !== cid || response.result == undefined) return;

                result.push(response.result);
                if (result.length >= reqsSent) {
                  worker.removeListener('message', callback);
                  sender.send(new IPCMessage({ from: 'master', to: sender.process.pid || 0, event: 'broadcast-response', data: result, cid: msg.cid }));
                }
              };

              worker.on('message', callback);
            }

            break;
          }

          case 'data-request': {
            const target = super.get(msg.to);
            if(target) {
              target.send(new IPCMessage({ from: msg.from, to: target.process.pid, event: msg.event, cid: msg.cid, data: msg.data }));
              let result: IResult;

              const callback = (message: any) => {
                const response = new IPCMessage(message);
                if(!response || response.cid != msg.cid || !response.result) return;

                result = response.result;
                target.removeListener('message', callback);
                sender.send(new IPCMessage({ from: msg.to || '', to: msg.from, event: 'data-response', cid: msg.cid, data: result }));
              };

              target.on('message', callback);
            }
          }
          }
        });
      }
    } else {
      process.on('message', (msg: any) => {
        if (msg.event == 'master-initial') {
          const options = {
            ...this.options,
            sharding: {
              totalShards: msg.shards.length,
              firstShardId: msg.shards[0],
              lastShardId: msg.total,
            },
          };

          const client = new ClusterClient(msg.token, options, msg.index);
          this.events.workerSpawned.notify(client);
        }
      });
    }

    return this;
  }
}
