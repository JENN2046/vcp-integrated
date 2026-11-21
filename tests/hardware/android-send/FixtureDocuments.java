package dev.nativesync.qa.send;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

public final class FixtureDocuments extends DocumentsProvider {
  private static final String AUTHORITY = "dev.nativesync.qa.send.documents";
  private static final String ROOT_ID = "fixture";
  private static final String FILE_ID = "fixture-note.txt";
  private static final byte[] CONTENT = "VCP physical attachment fixture 2026\n".getBytes(StandardCharsets.UTF_8);
  static final Uri ROOT = DocumentsContract.buildRootUri(AUTHORITY, ROOT_ID);
  static final Uri FILE_DOCUMENT = DocumentsContract.buildDocumentUri(AUTHORITY, FILE_ID);

  @Override public boolean onCreate() { return true; }

  @Override public Cursor queryRoots(String[] projection) {
    MatrixCursor cursor = new MatrixCursor(projection == null
      ? new String[]{Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_FLAGS, Root.COLUMN_MIME_TYPES}
      : projection);
    cursor.newRow().add(Root.COLUMN_ROOT_ID, ROOT_ID).add(Root.COLUMN_DOCUMENT_ID, ROOT_ID)
      .add(Root.COLUMN_TITLE, "NativeSync synthetic fixtures").add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY)
      .add(Root.COLUMN_MIME_TYPES, "text/plain");
    return cursor;
  }

  private MatrixCursor documents(String[] projection) {
    return new MatrixCursor(projection == null
      ? new String[]{Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE, Document.COLUMN_FLAGS} : projection);
  }

  private void addDocument(MatrixCursor cursor, String id) throws FileNotFoundException {
    if (ROOT_ID.equals(id)) {
      cursor.newRow().add(Document.COLUMN_DOCUMENT_ID, id).add(Document.COLUMN_DISPLAY_NAME, "NativeSync synthetic fixtures")
        .add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR).add(Document.COLUMN_FLAGS, 0);
    } else if (FILE_ID.equals(id)) {
      cursor.newRow().add(Document.COLUMN_DOCUMENT_ID, id).add(Document.COLUMN_DISPLAY_NAME, FILE_ID)
        .add(Document.COLUMN_MIME_TYPE, "text/plain").add(Document.COLUMN_FLAGS, 0).add(Document.COLUMN_SIZE, CONTENT.length);
    } else {
      throw new FileNotFoundException();
    }
  }

  @Override public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
    MatrixCursor cursor = documents(projection);
    addDocument(cursor, documentId);
    return cursor;
  }

  @Override public Cursor queryChildDocuments(String parent, String[] projection, String order) throws FileNotFoundException {
    if (!ROOT_ID.equals(parent)) throw new FileNotFoundException();
    MatrixCursor cursor = documents(projection);
    addDocument(cursor, FILE_ID);
    return cursor;
  }

  @Override public ParcelFileDescriptor openDocument(String documentId, String mode, CancellationSignal signal)
      throws FileNotFoundException {
    if (!FILE_ID.equals(documentId) || !"r".equals(mode)) throw new FileNotFoundException();
    File file = new File(getContext().getCacheDir(), FILE_ID);
    synchronized (this) {
      try (FileOutputStream output = new FileOutputStream(file)) {
        output.write(CONTENT);
      } catch (IOException error) {
        throw new FileNotFoundException();
      }
      return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
    }
  }
}
