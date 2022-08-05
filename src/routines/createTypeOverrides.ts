import {
  type Pool as PgPool,
} from 'pg';
import {
  getTypeParser,
} from 'pg-types';
import {
  parse as parseArray,
} from 'postgres-array';
import {
  type TypeParser,
} from '../types';

type PostgresType = {
  oid: string,
  typarray: string,
  typname: string,
};

export const createTypeOverrides = async (
  pool: PgPool,
  typeParsers: readonly TypeParser[],
) => {
  const typeNames = typeParsers.map((typeParser) => {
    return typeParser.name;
  });

  const connection = await pool.connect();

  const postgresTypes: PostgresType[] = (
    await connection.query('SELECT oid, typarray, typname FROM pg_type WHERE typname = ANY($1::text[])', [
      typeNames,
    ])
  ).rows;

  connection.release(true);

  const parsers = {};

  for (const typeParser of typeParsers) {
    const postgresType = postgresTypes.find((maybeTargetPostgresType) => {
      return maybeTargetPostgresType.typname === typeParser.name;
    });

    if (!postgresType) {
      throw new Error('Database type "' + typeParser.name + '" not found.');
    }

    parsers[postgresType.oid] = (value) => {
      return typeParser.parse(value);
    };

    if (postgresType.typarray) {
      parsers[postgresType.typarray] = (arrayValue) => {
        return parseArray(arrayValue)
          .map((value) => {
            return typeParser.parse(value);
          });
      };
    }
  }

  return (oid: number) => {
    if (parsers[oid]) {
      return parsers[oid];
    }

    return getTypeParser(oid);
  };
};
