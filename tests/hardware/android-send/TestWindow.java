package dev.nativesync.qa.send;
import android.app.Activity;
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
    page.getSettings().setAllowContentAccess(false);
    page.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    page.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest r) { return !allow(r.getUrl()); }
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest r) {
        return allow(r.getUrl()) ? null : new WebResourceResponse("text/plain","utf-8",new ByteArrayInputStream(new byte[0]));
      }
    });
    setContentView(page);
    page.loadUrl(ENTRY);
  }
  @Override protected void onPause(){super.onPause();page.onPause();}
  @Override protected void onResume(){super.onResume();page.onResume();}
  @Override protected void onDestroy(){page.destroy();super.onDestroy();}
}
