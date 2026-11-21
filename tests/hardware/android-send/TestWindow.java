package dev.nativesync.qa.send;
import android.app.Activity;
import android.content.Intent;
import android.provider.DocumentsContract;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.os.Bundle;
import android.net.Uri;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import java.io.ByteArrayInputStream;
public final class TestWindow extends Activity {
  private WebView page;
  private ValueCallback<Uri[]> fileSelection;
  private static final int OPEN_FIXTURE = 1;
  private static final String ENTRY = "https://127.0.0.1:FIXTURE_PORT/mobile/";
  private static boolean allow(Uri uri) {
    return "https".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort()==FIXTURE_PORT;
  }
  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    WebView.setWebContentsDebuggingEnabled(true);
    page=new WebView(this);
    page.getSettings().setJavaScriptEnabled(true);
    page.getSettings().setDomStorageEnabled(true);
    page.getSettings().setAllowFileAccess(false);
    page.getSettings().setAllowContentAccess(true);
    page.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    page.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest r) { return !allow(r.getUrl()); }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest r) {
        return allow(r.getUrl()) ? null : new WebResourceResponse("text/plain","utf-8",new ByteArrayInputStream(new byte[0]));
      }
    });
    page.setWebChromeClient(new WebChromeClient() {
      @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (fileSelection != null) fileSelection.onReceiveValue(null);
        fileSelection = callback;
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.setType("text/plain");
        picker.putExtra(Intent.EXTRA_LOCAL_ONLY, true);
        picker.putExtra(DocumentsContract.EXTRA_INITIAL_URI, FixtureDocuments.ROOT);
        for (String systemPicker : new String[]{"com.google.android.documentsui", "com.android.documentsui"}) {
          picker.setPackage(systemPicker);
          if (picker.resolveActivity(getPackageManager()) != null) {
            startActivityForResult(picker, OPEN_FIXTURE);
            return true;
          }
        }
        fileSelection.onReceiveValue(null);
        fileSelection = null;
        return true;
      }
    });
    setContentView(page);
    page.loadUrl(ENTRY);
  }
  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode != OPEN_FIXTURE || fileSelection == null) return;
    Uri chosen = data == null ? null : data.getData();
    fileSelection.onReceiveValue(resultCode == RESULT_OK && FixtureDocuments.FILE_DOCUMENT.equals(chosen)
      ? new Uri[]{chosen} : null);
    fileSelection = null;
  }
  @Override protected void onPause(){super.onPause();page.onPause();}
  @Override protected void onResume(){super.onResume();page.onResume();}
  @Override protected void onDestroy(){page.destroy();super.onDestroy();}
}
