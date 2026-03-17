/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/ui/serverWidget', 'N/https', 'N/log'], (serverWidget, https, log) => {

  const RENDER_URL = 'https://ns-grant-code-generator.onrender.com';

  const CONFIG = {
    authUrl: 'https://tstdrv2149584.app.netsuite.com/app/login/oauth2/authorize.nl',
    tokenUrl: 'https://tstdrv2149584.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token',
    clientId: '669b613664677bed6111dc2ffc78f4d986a0c25b353389019c6a7f756e0c21e4',
    clientSecret: 'f1453a6f8e5095bb1f3deeeeae6c8823766784a27c8934c5c7e05451e7c1163b',
    redirectUri: 'https://softype.com',
    scope: 'restlets rest_webservices',
    state: 'ykv2XLx1BpT5Q0F3MRPHb94j',
    nsEmail: 'atharvap@softype.com',
    nsPassword: 'Ventus@12345',
  };

  const onRequest = (context) => {
    const { request, response } = context;

    // ─── POST: Kick off /get-tokens, return jobId to client ───
    if (request.method === 'POST') {
      const step = request.parameters.step;

      if (step === 'start') {
        try {
          const startResponse = https.post({
            url: `${RENDER_URL}/get-tokens`,
            body: JSON.stringify(CONFIG),
            headers: { 'Content-Type': 'application/json' },
          });
          const result = JSON.parse(startResponse.body);
          log.debug('get-tokens', JSON.stringify(result));
          response.write(JSON.stringify(result));
        } catch (e) {
          log.error('get-tokens error', e.message);
          response.write(JSON.stringify({ status: 'error', error: e.message }));
        }
        return;
      }

      if (step === 'submit_otp') {
        const sessionId = request.parameters.sessionId;
        const otpCode = request.parameters.otpCode;
        try {
          const submitResponse = https.post({
            url: `${RENDER_URL}/submit-otp`,
            body: JSON.stringify({ sessionId, otpCode }),
            headers: { 'Content-Type': 'application/json' },
          });
          const result = JSON.parse(submitResponse.body);
          log.debug('submit-otp', JSON.stringify(result));
          response.write(JSON.stringify(result));
        } catch (e) {
          log.error('submit-otp error', e.message);
          response.write(JSON.stringify({ status: 'error', error: e.message }));
        }
        return;
      }

      if (step === 'poll') {
        const jobId = request.parameters.jobId;
        try {
          const pollResponse = https.get({
            url: `${RENDER_URL}/job-status/${jobId}`,
          });
          const result = JSON.parse(pollResponse.body);
          log.debug('poll', JSON.stringify(result));
          response.write(JSON.stringify(result));
        } catch (e) {
          log.error('poll error', e.message);
          response.write(JSON.stringify({ status: 'error', error: e.message }));
        }
        return;
      }
    }

    // ─── GET: Render the main UI page ───
    const form = serverWidget.createForm({ title: 'NetSuite OAuth Token Generator' });
    const scriptletUrl = context.request.url;

    form.addField({
      id: 'custpage_ui',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'UI',
    }).defaultValue = `
      <style>
        #oauth-container { font-family: Arial; padding: 20px; max-width: 800px; }
        #status-msg { margin: 10px 0; color: #555; font-style: italic; }
        .token-box { width: 100%; height: 80px; margin: 5px 0 15px 0; padding: 8px; font-size: 12px; }
        .btn { padding: 10px 20px; background: #0077b6; color: white; border: none; cursor: pointer; border-radius: 4px; font-size: 14px; }
        .btn:disabled { background: #aaa; cursor: not-allowed; }
        #otp-section { display: none; margin-top: 20px; }
        #otp-input { padding: 8px; font-size: 16px; width: 150px; letter-spacing: 4px; }
        #token-section { display: none; margin-top: 20px; }
        .error { color: red; }
      </style>

      <div id="oauth-container">
        <button class="btn" id="start-btn" onclick="startFlow()">Generate Access Token</button>
        <p id="status-msg"></p>

        <div id="otp-section">
          <p>2FA required! Enter your 6-digit code:</p>
          <input type="text" id="otp-input" maxlength="6" placeholder="000000" />
          <button class="btn" onclick="submitOtp()" style="margin-left:10px;">Submit OTP</button>
        </div>

        <div id="token-section">
          <h3>Tokens Generated Successfully!</h3>
          <label><b>Access Token:</b></label>
          <textarea class="token-box" id="access-token" readonly></textarea>
          <label><b>Refresh Token:</b></label>
          <textarea class="token-box" id="refresh-token" readonly></textarea>
          <label><b>Expires In (seconds):</b></label>
          <input type="text" id="expires-in" readonly style="padding:6px; width:100px;" />
        </div>
      </div>

      <script>
        const SUITELET_URL = '${scriptletUrl}';
        let currentSessionId = null;
        let pollInterval = null;

        function setStatus(msg, isError) {
          const el = document.getElementById('status-msg');
          el.textContent = msg;
          el.className = isError ? 'error' : '';
        }

        async function startFlow() {
          document.getElementById('start-btn').disabled = true;
          document.getElementById('otp-section').style.display = 'none';
          document.getElementById('token-section').style.display = 'none';
          setStatus('Starting OAuth flow...');

          try {
            const res = await fetch(SUITELET_URL + '&step=start', { method: 'POST' });
            const data = await res.json();

            if (data.status === 'processing' && data.jobId) {
              setStatus('Logging in to NetSuite...');
              startPolling(data.jobId, 'start');
            } else {
              setStatus('Error: ' + (data.error || 'Unknown error'), true);
              document.getElementById('start-btn').disabled = false;
            }
          } catch (e) {
            setStatus('Error: ' + e.message, true);
            document.getElementById('start-btn').disabled = false;
          }
        }

        async function submitOtp() {
          const otpCode = document.getElementById('otp-input').value.trim();
          if (otpCode.length !== 6) {
            setStatus('Please enter a valid 6-digit code', true);
            return;
          }

          setStatus('Submitting OTP...');

          try {
            const res = await fetch(SUITELET_URL + '&step=submit_otp&sessionId=' + currentSessionId + '&otpCode=' + otpCode, { method: 'POST' });
            const data = await res.json();

            if (data.status === 'processing' && data.jobId) {
              setStatus('Verifying OTP...');
              startPolling(data.jobId, 'otp');
            } else {
              setStatus('Error: ' + (data.error || 'Unknown error'), true);
            }
          } catch (e) {
            setStatus('Error: ' + e.message, true);
          }
        }

        function startPolling(jobId, phase) {
          if (pollInterval) clearInterval(pollInterval);

          pollInterval = setInterval(async () => {
            try {
              const res = await fetch(SUITELET_URL + '&step=poll&jobId=' + jobId, { method: 'POST' });
              const data = await res.json();

              if (data.status === 'otp_required') {
                clearInterval(pollInterval);
                currentSessionId = data.sessionId;
                setStatus('2FA required! Enter your OTP code.');
                document.getElementById('otp-section').style.display = 'block';
              } else if (data.status === 'success') {
                clearInterval(pollInterval);
                setStatus('Tokens generated successfully!');
                document.getElementById('token-section').style.display = 'block';
                document.getElementById('access-token').value = data.tokens.access_token || '';
                document.getElementById('refresh-token').value = data.tokens.refresh_token || '';
                document.getElementById('expires-in').value = data.tokens.expires_in || '';
                document.getElementById('start-btn').disabled = false;
              } else if (data.status === 'error') {
                clearInterval(pollInterval);
                setStatus('Error: ' + data.error, true);
                document.getElementById('start-btn').disabled = false;
              } else {
                setStatus('Processing... please wait');
              }
            } catch (e) {
              setStatus('Polling error: ' + e.message, true);
            }
          }, 3000);
        }
      </script>
    `;

    response.writePage(form);
  };

  return { onRequest };
});
