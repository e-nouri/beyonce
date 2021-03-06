import { JayZ } from "@ginger.io/jay-z"
import { DynamoDB } from "aws-sdk"
import { groupModelsByType } from "./groupModelsByType"
import { PartitionAndSortKey, PartitionKey } from "./keys"
import { QueryBuilder } from "./QueryBuilder"
import { Table } from "./Table"
import { ExtractKeyType, GroupedModels, TaggedModel } from "./types"
import {
  decryptOrPassThroughItem,
  encryptOrPassThroughItems,
  MaybeEncryptedItems,
  toJSON,
} from "./util"

export type Options = {
  jayz?: JayZ
}

/** A thin wrapper around the DynamoDB sdk client that
 * does auto mapping between JSON <=> DynamoDB Items
 */
export class Beyonce {
  private client: DynamoDB.DocumentClient
  private jayz?: JayZ

  constructor(private table: Table, dynamo: DynamoDB, options: Options = {}) {
    this.client = new DynamoDB.DocumentClient({ service: dynamo })

    if (options.jayz !== undefined) {
      this.jayz = options.jayz
    }
  }

  /** Retrieve a single Item out of Dynamo */
  async get<T extends TaggedModel>(
    key: PartitionAndSortKey<T>
  ): Promise<T | undefined> {
    const { Item: item } = await this.client
      .get({
        TableName: this.table.tableName,
        Key: {
          [this.table.partitionKeyName]: key.partitionKey,
          [this.table.sortKeyName]: key.sortKey,
        },
      })
      .promise()

    if (item !== undefined) {
      return toJSON<T>(await decryptOrPassThroughItem(this.jayz, item))
    }
  }

  /** BatchGet items */
  async batchGet<T extends PartitionAndSortKey<TaggedModel>>(params: {
    keys: T[]
  }): Promise<GroupedModels<ExtractKeyType<T>>> {
    const {
      Responses: responses,
      UnprocessedKeys: unprocessedKeys,
    } = await this.client
      .batchGet({
        RequestItems: {
          [this.table.tableName]: {
            Keys: params.keys.map(({ partitionKey, sortKey }) => ({
              [this.table.partitionKeyName]: partitionKey,
              [this.table.sortKeyName]: sortKey,
            })),
          },
        },
      })
      .promise()

    if (unprocessedKeys !== undefined) {
      console.error("Some keys didn't process", unprocessedKeys)
    }

    if (responses !== undefined) {
      const items = responses[this.table.tableName]
      const jsonItemPromises = items.map(async (_) => {
        const item = await decryptOrPassThroughItem(this.jayz, _)
        return toJSON<ExtractKeyType<T>>(item)
      })

      const jsonItems = await Promise.all(jsonItemPromises)
      return groupModelsByType(jsonItems)
    } else {
      return groupModelsByType<ExtractKeyType<T>>([])
    }
  }

  query<T extends TaggedModel>(pk: PartitionKey<T>): QueryBuilder<T> {
    const { table, jayz } = this
    return new QueryBuilder<T>({
      db: this.client,
      table,
      pk,
      jayz: jayz,
    })
  }

  queryGSI<T extends TaggedModel>(
    gsiName: string,
    gsiPk: PartitionKey<T>
  ): QueryBuilder<T> {
    const { table, jayz } = this
    return new QueryBuilder<T>({
      db: this.client,
      table,
      gsiName,
      gsiPk,
      jayz,
    })
  }

  /** Write an item into Dynamo */
  async put<T extends TaggedModel>(item: T): Promise<void> {
    const maybeEncryptedItem = await this.maybeEncryptItems(item)

    await this.client
      .put({
        TableName: this.table.tableName,
        Item: maybeEncryptedItem,
      })
      .promise()
  }

  /** Write multiple items into Dynamo using a transaction.
   */
  async batchPutWithTransaction<T extends TaggedModel>(params: {
    items: T[]
  }): Promise<void> {
    const asyncEncryptedItems = params.items.map(async (item) => {
      const maybeEncryptedItem = await this.maybeEncryptItems(item)
      return {
        Put: { TableName: this.table.tableName, Item: maybeEncryptedItem },
      }
    })

    const encryptedItems = await Promise.all(asyncEncryptedItems)

    await this.client
      .transactWrite({
        TransactItems: encryptedItems,
      })
      .promise()
  }

  private async maybeEncryptItems<T extends TaggedModel>(
    item: T
  ): Promise<MaybeEncryptedItems<T>> {
    const { jayz, table } = this

    return await encryptOrPassThroughItems(
      jayz,
      item,
      table.getEncryptionBlacklist()
    )
  }
}
