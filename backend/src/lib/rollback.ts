import type {PoolClient} from 'pg';
/** A disconnected database may fail ROLLBACK too; preserve the actual operation error. */
export async function rollbackPreservingError(client:Pick<PoolClient,'query'>,original:unknown):Promise<never>{
 try{await client.query('ROLLBACK');}catch{}
 throw original;
}
