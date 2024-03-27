import { bindPoolConnection } from '../binders/bindPoolConnection';
import { UnexpectedStateError } from '../errors';
import { establishConnection } from '../routines/establishConnection';
import { getPoolClientState } from '../state';
import {
  type ClientConfiguration,
  type Connection,
  type DatabasePool,
  type DatabasePoolConnection,
  type Logger,
  type MaybePromise,
  type QuerySqlToken,
} from '../types';
import {
  type ConnectionPool,
  type ConnectionPoolClient,
} from './createConnectionPool';

type ConnectionHandlerType = (
  connectionLog: Logger,
  connection: ConnectionPoolClient,
  boundConnection: DatabasePoolConnection,
  clientConfiguration: ClientConfiguration,
) => MaybePromise<unknown>;

type PoolHandlerType = (pool: DatabasePool) => Promise<unknown>;

const destroyBoundConnection = (boundConnection: DatabasePoolConnection) => {
  const boundConnectionMethods = [
    'any',
    'anyFirst',
    'exists',
    'many',
    'manyFirst',
    'maybeOne',
    'maybeOneFirst',
    'one',
    'oneFirst',
    'query',
    'stream',
    'transaction',
  ];

  for (const boundConnectionMethod of boundConnectionMethods) {
    boundConnection[boundConnectionMethod] = async () => {
      throw new Error('Cannot use released connection');
    };
  }
};

export const createConnection = async (
  parentLog: Logger,
  pool: ConnectionPool,
  clientConfiguration: ClientConfiguration,
  connectionType: Connection,
  connectionHandler: ConnectionHandlerType,
  poolHandler: PoolHandlerType,
  query: QuerySqlToken | null = null,
) => {
  const { ended } = pool.state();

  const poolId = pool.id();

  if (ended) {
    throw new UnexpectedStateError(
      'Connection pool shutdown has been already initiated. Cannot create a new connection.',
    );
  }

  for (const interceptor of clientConfiguration.interceptors) {
    if (interceptor.beforePoolConnection) {
      const maybeNewPool = await interceptor.beforePoolConnection({
        log: parentLog,
        poolId,
        query,
      });

      if (maybeNewPool) {
        return await poolHandler(maybeNewPool);
      }
    }
  }

  const connection = await establishConnection(
    parentLog,
    pool,
    clientConfiguration.connectionRetryLimit,
  );

  const { connectionId } = getPoolClientState(connection);

  const connectionLog = parentLog.child({
    connectionId,
  });

  const connectionContext = {
    connectionId,
    connectionType,
    log: connectionLog,
    poolId,
  };

  const boundConnection = bindPoolConnection(
    connectionLog,
    connection,
    clientConfiguration,
  );

  try {
    for (const interceptor of clientConfiguration.interceptors) {
      if (interceptor.afterPoolConnection) {
        await interceptor.afterPoolConnection(
          connectionContext,
          boundConnection,
        );
      }
    }
  } catch (error) {
    await connection.destroy();

    throw error;
  }

  let result;

  try {
    result = await connectionHandler(
      connectionLog,
      connection,
      boundConnection,
      clientConfiguration,
    );
  } catch (error) {
    await connection.destroy();

    throw error;
  }

  try {
    for (const interceptor of clientConfiguration.interceptors) {
      if (interceptor.beforePoolConnectionRelease) {
        await interceptor.beforePoolConnectionRelease(
          connectionContext,
          boundConnection,
        );
      }
    }
  } catch (error) {
    await connection.destroy();

    throw error;
  }

  destroyBoundConnection(boundConnection);

  await connection.release();

  return result;
};
