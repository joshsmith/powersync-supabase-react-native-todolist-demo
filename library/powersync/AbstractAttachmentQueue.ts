import { AbstractPowerSyncDatabase, Transaction } from '@journeyapps/powersync-sdk-react-native';
import { ATTACHMENT_TABLE, AttachmentRecord, AttachmentState } from './AppSchema';
import { AbstractStorageAdapter, EncodingType } from '../storage/AbstractStorageAdapter';

export const ATTACHMENT_LOCAL_STORAGE_DIR = 'attachments';
export const ATTACHMENT_QUEUE_INTERVAL = 30_000;
export const ATTACHMENT_CACHE_LIMIT = 100;

export interface AttachmentQueueOptions {
  powersync: AbstractPowerSyncDatabase;
  storage: AbstractStorageAdapter;
  syncInterval?: number;
  cacheLimit?: number;
  attachmentDirectoryName?: string;
}

export abstract class AbstractAttachmentQueue<T extends AttachmentQueueOptions = AttachmentQueueOptions> {
  uploading: boolean;
  downloading: boolean;
  initialSync: boolean;
  options: T;
  downloadQueue: Set<string>;

  constructor(options: T) {
    this.options = {
      ...options,
      attachmentDirectoryName: options.attachmentDirectoryName ?? ATTACHMENT_LOCAL_STORAGE_DIR,
      syncInterval: options.syncInterval ?? ATTACHMENT_QUEUE_INTERVAL,
      cacheLimit: options.cacheLimit ?? ATTACHMENT_CACHE_LIMIT
    };
    this.downloadQueue = new Set<string>();
    this.uploading = false;
    this.downloading = false;
    this.initialSync = true;
  }

  /**
   * Returns an async iterator that yields attachment IDs that need to be synced.
   * In most cases this will be a watch query
   *
   * Example:
   * for await (const result of powersync.watch('SELECT photo_id as id FROM todos WHERE photo_id IS NOT NULL', [])) {
   *    yield result.rows?._array.map((r) => r.id) ?? [];
   * }
   */
  abstract attachmentIds(): AsyncIterable<string[]>;

  /**
   * Create a new AttachmentRecord, this gets called when the attachment id is not found in the database.
   */
  abstract newAttachmentRecord(record?: Partial<AttachmentRecord>): AttachmentRecord;

  protected get powersync() {
    return this.options.powersync;
  }

  protected get storage() {
    return this.options.storage;
  }

  get table() {
    return ATTACHMENT_TABLE;
  }

  get storageDirectory() {
    return `${this.storage.getUserStorageDirectory()}${this.options.attachmentDirectoryName}`;
  }

  async init() {
    this.watchAttachmentIds();
    this.watchUploads();
    this.watchDownloads();

    // In addition to watching for changes, we also trigger a sync every few seconds (30 seconds, by default)
    // This will retry any failed uploads/downloads, in particular after the app was offline
    setInterval(() => this.trigger(), ATTACHMENT_QUEUE_INTERVAL);
  }

  trigger() {
    this.uploadRecords();
    this.downloadRecords();
    this.expireCache();
  }

  async watchAttachmentIds() {
    for await (const ids of this.attachmentIds()) {
      const _ids = `${ids.map((id) => `'${id}'`).join(',')}`;
      console.debug(`Queuing for sync, attachment IDs: [${_ids}]`);

      if (this.initialSync) {
        this.initialSync = false;
        // Mark AttachmentIds for sync
        await this.powersync.execute(
          `UPDATE 
                ${this.table} 
              SET state = ${AttachmentState.QUEUED_SYNC} 
              WHERE 
                state < ${AttachmentState.SYNCED} 
              AND
               id IN (${_ids})`
        );
      }

      const attachmentsInDatabase = await this.powersync.getAll<AttachmentRecord>(
        `SELECT * FROM ${this.table} WHERE state < ${AttachmentState.ARCHIVED}`
      );

      for (const id of ids) {
        const record = attachmentsInDatabase.find((r) => r.id == id);
        // 1. ID is not in the database
        if (!record) {
          const newRecord = this.newAttachmentRecord({
            id: id,
            state: AttachmentState.QUEUED_SYNC
          });
          console.debug(`Attachment (${id}) not found in database, creating new record`);
          await this.saveToQueue(newRecord);
        } else if (record.local_uri == null || !(await this.storage.fileExists(record.local_uri))) {
          // 2. Attachment in database but no local file, mark as queued download
          console.debug(`Attachment (${id}) found in database but no local file, marking as queued download`);
          await this.update({ ...record, state: AttachmentState.QUEUED_DOWNLOAD });
        }
      }

      // 3. Attachment in database and not in AttachmentIds, mark as archived
      await this.powersync.execute(
        `UPDATE ${this.table} SET state = ${AttachmentState.ARCHIVED} WHERE state < ${
          AttachmentState.ARCHIVED
        } AND id NOT IN (${ids.map((id) => `'${id}'`).join(',')})`
      );
    }
  }

  async saveToQueue(record: Omit<AttachmentRecord, 'timestamp'>): Promise<AttachmentRecord> {
    const updatedRecord: AttachmentRecord = {
      ...record,
      timestamp: new Date().getTime()
    };

    await this.powersync.execute(
      `INSERT OR REPLACE INTO ${this.table} (id, timestamp, filename, local_uri, media_type, size, state) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        updatedRecord.id,
        updatedRecord.timestamp,
        updatedRecord.filename,
        updatedRecord.local_uri || null,
        updatedRecord.media_type || null,
        updatedRecord.size || null,
        updatedRecord.state
      ]
    );

    return updatedRecord;
  }

  async record(id: string): Promise<AttachmentRecord | null> {
    return this.powersync.getOptional<AttachmentRecord>(`SELECT * FROM ${this.table} WHERE id = ?`, [id]);
  }

  async update(record: Omit<AttachmentRecord, 'timestamp'>): Promise<void> {
    const timestamp = new Date().getTime();
    await this.powersync.execute(
      `UPDATE ${this.table}
             SET 
                timestamp = ?,
                filename = ?,
                local_uri = ?,
                size = ?,
                media_type = ?,
                state = ?
             WHERE id = ?`,
      [timestamp, record.filename, record.local_uri || null, record.size, record.media_type, record.state, record.id]
    );
  }

  async delete(record: AttachmentRecord, tx?: Transaction): Promise<void> {
    const deleteRecord = async (tx: Transaction) => {
      await tx.execute(
        `DELETE
             FROM ${this.table}
             WHERE id = ?`,
        [record.id]
      );
    };

    if (tx) {
      await deleteRecord(tx);
    } else {
      await this.powersync.writeTransaction(deleteRecord);
    }

    const uri = record.local_uri || this.getLocalUri(record.filename);

    try {
      // Delete file on storage
      await this.storage.deleteFile(uri, {
        filename: record.filename
      });
    } catch (e) {
      console.error(e);
    }
  }

  async getNextUploadRecord(): Promise<AttachmentRecord | null> {
    return this.powersync.getOptional<AttachmentRecord>(
      `SELECT *
                FROM ${this.table}
                WHERE
                  local_uri IS NOT NULL
                AND
                  (state = ${AttachmentState.QUEUED_UPLOAD}
                OR
                  state = ${AttachmentState.QUEUED_SYNC})
                ORDER BY timestamp ASC`
    );
  }

  async uploadAttachment(record: AttachmentRecord) {
    if (!record.local_uri) {
      throw new Error(`No local_uri for record ${JSON.stringify(record, null, 2)}`);
    }
    try {
      if (!(await this.storage.fileExists(record.local_uri))) {
        console.warn(`File for ${record.id} does not exist, skipping upload`);
        await this.update({ ...record, state: AttachmentState.QUEUED_DOWNLOAD });
        return true;
      }

      const fileBuffer = await this.storage.readFile(record.local_uri, {
        encoding: EncodingType.Base64,
        mediaType: record.media_type
      });

      await this.storage.uploadFile(record.filename, fileBuffer, { mediaType: record.media_type });
      // Mark as uploaded
      await this.update({ ...record, state: AttachmentState.SYNCED });
      console.debug(`Uploaded attachment "${record.id}" to Cloud Storage`);
      return true;
    } catch (e: any) {
      if (e.error == 'Duplicate') {
        console.debug(`File already uploaded, marking ${record.id} as synced`);
        await this.update({ ...record, state: AttachmentState.SYNCED });
        return false;
      }
      console.error(`UploadAttachment error for record ${JSON.stringify(record, null, 2)}`, e);
      return false;
    }
  }

  async downloadRecord(record: AttachmentRecord) {
    if (!record.local_uri) {
      record.local_uri = this.getLocalUri(record.filename);
    }
    if (await this.storage.fileExists(record.local_uri)) {
      console.debug(`Local file already downloaded, marking "${record.id}" as synced`);
      await this.update({ ...record, state: AttachmentState.SYNCED });
      return true;
    }

    try {
      const fileBlob = await this.storage.downloadFile(record.filename);

      // Convert the blob data into a base64 string
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          // remove the header from the result: 'data:*/*;base64,'
          resolve(reader.result?.toString().replace(/^data:.+;base64,/, '') || '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(fileBlob);
      });

      // Ensure directory exists
      await this.storage.makeDir(record.local_uri.replace(record.filename, ''));
      // Write the file
      await this.storage.writeFile(record.local_uri, base64Data, { encoding: EncodingType.Base64 });

      await this.update({ ...record, media_type: fileBlob.type, state: AttachmentState.SYNCED });
      console.debug(`Downloaded attachment "${record.id}"`);
      return true;
    } catch (e) {
      console.error(`Download attachment error for record ${JSON.stringify(record, null, 2)}`, e);
    }
    return false;
  }

  async *idsToUpload(): AsyncIterable<string[]> {
    for await (const result of this.powersync.watch(
      `SELECT id
              FROM ${this.table} 
              WHERE
                local_uri IS NOT NULL
              AND
                (state = ${AttachmentState.QUEUED_UPLOAD} 
              OR
                state = ${AttachmentState.QUEUED_SYNC})`,
      []
    )) {
      yield result.rows?._array.map((r) => r.id) || [];
    }
  }

  async watchUploads() {
    for await (const ids of this.idsToUpload()) {
      if (ids.length > 0) {
        await this.uploadRecords();
      }
    }
  }

  /**
   * Returns immediately if another loop is in progress.
   */
  private async uploadRecords() {
    if (this.uploading) {
      return;
    }
    this.uploading = true;
    try {
      let record = await this.getNextUploadRecord();
      if (!record) {
        return;
      }
      console.debug(`Uploading attachments...`);
      while (record) {
        const uploaded = await this.uploadAttachment(record);
        if (!uploaded) {
          // Then attachment failed to upload. We try all uploads when the next trigger() is called
          break;
        }
        record = await this.getNextUploadRecord();
      }
      console.debug('Finished uploading attachments');
    } catch (error) {
      console.error('Upload failed:', error);
    } finally {
      this.uploading = false;
    }
  }

  async getIdsToDownload(): Promise<string[]> {
    const res = await this.powersync.getAll<{ id: string }>(
      `SELECT id
              FROM ${this.table} 
              WHERE
                state = ${AttachmentState.QUEUED_DOWNLOAD} 
              OR
                state = ${AttachmentState.QUEUED_SYNC}
              ORDER BY timestamp ASC`
    );
    return res.map((r) => r.id);
  }

  async *idsToDownload(): AsyncIterable<string[]> {
    for await (const result of this.powersync.watch(
      `SELECT id
              FROM ${this.table} 
              WHERE 
                state = ${AttachmentState.QUEUED_DOWNLOAD} 
              OR 
                state = ${AttachmentState.QUEUED_SYNC}`,
      []
    )) {
      yield result.rows?._array.map((r) => r.id) || [];
    }
  }

  async watchDownloads() {
    for await (const ids of this.idsToDownload()) {
      ids.map((id) => this.downloadQueue.add(id));
      // No need to await this, the lock will ensure only loop is running at a time
      this.downloadRecords();
    }
  }

  private async downloadRecords() {
    if (this.downloading) {
      return;
    }
    (await this.getIdsToDownload()).map((id) => this.downloadQueue.add(id));
    if (this.downloadQueue.size == 0) {
      return;
    }

    this.downloading = true;
    try {
      console.debug(`Downloading ${this.downloadQueue.size} attachments...`);
      while (this.downloadQueue.size > 0) {
        const id = this.downloadQueue.values().next().value;
        this.downloadQueue.delete(id);
        const record = await this.record(id);
        if (!record) {
          continue;
        }
        await this.downloadRecord(record);
      }
      console.debug('Finished downloading attachments');
    } catch (e) {
      console.error('Downloads failed:', e);
    } finally {
      this.downloading = false;
    }
  }

  getLocalUri(filename: string): string {
    return `${this.storageDirectory}/${filename}`;
  }

  async expireCache() {
    const res = await this.powersync.getAll<AttachmentRecord>(`SELECT * FROM ${this.table} 
          WHERE 
           state = ${AttachmentState.SYNCED} OR state = ${AttachmentState.ARCHIVED}
         ORDER BY 
           timestamp DESC
         LIMIT 100 OFFSET ${this.options.cacheLimit}`);

    if (res.length == 0) {
      return;
    }

    console.debug(`Deleting ${res.length} attachments from cache...`);
    await this.powersync.writeTransaction(async (tx) => {
      for (const record of res) {
        await this.delete(record, tx);
      }
    });
  }

  async clearQueue(): Promise<void> {
    console.debug(`Clearing attachment queue...`);
    await this.powersync.writeTransaction(async (tx) => {
      await tx.execute(`DELETE FROM ${this.table}`);
    });
  }
}
