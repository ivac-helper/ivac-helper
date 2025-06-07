// ==UserScript==
// @name         code test
// @namespace    http://tampermonkey.net/
// @version      10.0
// @description  Easy Payment All info submission,OTP verification, payment Done
// @match        https://payment.ivacbd.com/*
// @grant        none
// @author       DHAKA
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    // ======================
    // CONFIGURATION SECTION
    // ======================
    const CONFIG = {
        // Default appointment date (easily changeable here)
        defaultDate: "2025-06-09",

        // Application Information
        application: {
            highcom: "1",
            webFileId: "BGDDV426A925",
            ivacId: "17",
            visaType: "13",
            familyCount: "0", // Must match number of family members below
            visitPurpose: "PURPOSE FOR MEDICAL"
        },

        // Personal Information
        personal: {
            fullName: "RUPCHAD SARKAR",
            email: "ACTIVEHIGH1@GMAIL.COM",
            phone: "01782380142",

            // Family Members (up to 3)
            familyMembers: [
                {
                    name: "",
                    webFileNo: ""
                }
            ]
        }
    };

    // API Endpoints
    const API_URLS = {
        sendOtp: "https://payment.ivacbd.com/pay-otp-sent",
        verifyOtp: "https://payment.ivacbd.com/pay-otp-verify",
        slotTime: "https://payment.ivacbd.com/pay-slot-time",
        payNow: "https://payment.ivacbd.com/paynow",
        applicationInfo: "https://payment.ivacbd.com/application-info-submit",
        personalInfo: "https://payment.ivacbd.com/personal-info-submit",
        paymentSubmit: "https://payment.ivacbd.com/overview-submit"
    };

    // Global State
    let globalStop = false;
    let csrfToken = null;
    let statusMessageEl = null;
    let activeRequests = [];
    let selectedDate = CONFIG.defaultDate;
    let selectedTime = null;
    let recaptchaWidgetId = null;
    let hashParam = null;
    let recaptchaToken = null;
    let recaptchaSiteKey = '6LdOCpAqAAAAAOLNB3Vwt_H7Nw4GGCAbdYm5Brsb';
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };
    let isRecaptchaLoaded = false;
    let isOtpVerified = false;
    let hashObserver = null;

    // Helper Functions
    function logInfo(msg) {
        console.log(`[INFO] ${msg}`);
        if (statusMessageEl) {
            statusMessageEl.textContent = msg;
            statusMessageEl.style.color = "#5a5a5a";
        }
    }

    function logError(msg) {
        console.error(`[ERROR] ${msg}`);
        if (statusMessageEl) {
            statusMessageEl.textContent = msg;
            statusMessageEl.style.color = "#ff4444";
        }
    }

    function logSuccess(msg) {
        console.log(`[SUCCESS] ${msg}`);
        if (statusMessageEl) {
            statusMessageEl.textContent = msg;
            statusMessageEl.style.color = "#00C851";
        }
    }

    function retrieveCsrfToken() {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
            const match = script.innerHTML.match(/var csrf_token = "(.*?)"/);
            if (match && match[1]) {
                return match[1];
            }
        }

        const meta = document.querySelector("meta[name='csrf-token']");
        return meta?.content || document.querySelector("input[name='_token']")?.value || null;
    }

    function getHashParam() {
        const sources = [
            () => document.querySelector("input[name='hash_param']")?.value,
            () => {
                const urlParams = new URLSearchParams(window.location.search);
                return urlParams.get('hash_param');
            },
            () => {
                const inputs = document.querySelectorAll('input[type="hidden"]');
                for (let input of inputs) {
                    if (input.name.includes('hash') || input.id.includes('hash')) {
                        return input.value;
                    }
                }
                return null;
            }
        ];

        for (let source of sources) {
            const hash = source();
            if (hash) return hash;
        }

        return null;
    }

    function initializeHashParam() {
        hashParam = getHashParam();
        /*if (!hashParam) {
            logInfo("Hash parameter will be obtained after OTP verification");
        } else {
            logInfo("Hash parameter loaded from page");
        }*/

        if (!hashObserver) {
            hashObserver = new MutationObserver(() => {
                const newHash = getHashParam();
                if (newHash && newHash !== hashParam) {
                    hashParam = newHash;
                    logInfo("Hash parameter updated dynamically");
                }
            });

            hashObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true
            });
        }
    }

    async function sendPostRequest(url, data) {
        if (!csrfToken) {
            csrfToken = retrieveCsrfToken();
            if (!csrfToken) {
                logError("CSRF token not found");
                return null;
            }
        }

        data._token = csrfToken;
        const controller = new AbortController();
        activeRequests.push(controller);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: new URLSearchParams(data),
                signal: controller.signal,
                redirect: 'manual'
            });

            if (response.redirected || response.status === 302) {
                return { success: true, redirected: true };
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                return { success: true, redirected: false };
            }

        } catch (err) {
            if (err.name !== "AbortError") {
                logError(`Request failed: ${err.message}`);
            }
            return null;
        } finally {
            activeRequests = activeRequests.filter(req => req !== controller);
        }
    }

    // Draggable Panel Functionality
    function makeDraggable(panel, header) {
        header.style.cursor = 'move';

        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;

            isDragging = true;
            dragOffset = {
                x: e.clientX - panel.getBoundingClientRect().left,
                y: e.clientY - panel.getBoundingClientRect().top
            };

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            panel.style.left = `${e.clientX - dragOffset.x}px`;
            panel.style.top = `${e.clientY - dragOffset.y}px`;
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    // OTP Functions
    async function sendOtp(resend = false) {
        logInfo(resend ? "Resending OTP..." : "Sending OTP...");
        const result = await sendPostRequest(API_URLS.sendOtp, { resend: resend ? 1 : 0 });
        if (result?.success) {
            logSuccess(`? OTP ${resend ? 're' : ''}sent successfully`);
        } else if (result) {
            logError(`Failed to ${resend ? 're' : ''}send OTP`);
        }
    }

    async function verifyOtp() {
        const otp = document.getElementById("ivac-otp-input")?.value;
        if (!otp || otp.length !== 6) {
            logError("Please enter 6-digit OTP");
            return;
        }

        logInfo("Verifying OTP...");
        const result = await sendPostRequest(API_URLS.verifyOtp, { otp });
        if (result?.success) {
            isOtpVerified = true;
            logSuccess("? OTP verified");

            hashParam = result.data?.hash_param || getHashParam();

            /*if (hashParam) {
                logInfo("Hash parameter obtained successfully");
            } else {
                logError("Warning: Hash parameter not found after verification");
            }*/

            updateDateDropdown(result.data?.slot_dates || []);
        } else if (result) {
            logError("? Invalid OTP");
        }
    }

    async function getSlotTimes() {
        if (!selectedDate) {
            logError("Please select a date first");
            return;
        }

        logInfo(`Fetching slots for ${selectedDate}...`);
        const result = await sendPostRequest(API_URLS.slotTime, { appointment_date: selectedDate });
        if (result?.success) {
            logSuccess("? Slots loaded");
            updateTimeDropdown(result.data?.slot_times || []);
            loadRecaptcha();
        } else if (result) {
            logError("Failed to load slots");
        }
    }

    function loadRecaptcha() {
        if (isRecaptchaLoaded) {
            grecaptcha.reset(recaptchaWidgetId);
            return;
        }

        return new Promise((resolve) => {
            const recaptchaContainer = document.getElementById("ivac-recaptcha-container");

            // Create a clean container to avoid ARIA conflicts
            recaptchaContainer.innerHTML = '';
            const cleanContainer = document.createElement('div');
            cleanContainer.id = 'ivac-recaptcha-wrapper';
            recaptchaContainer.appendChild(cleanContainer);

            cleanContainer.innerHTML = `
                <div class="g-recaptcha" id="ivac-recaptcha"
                     data-sitekey="${recaptchaSiteKey}"
                     data-callback="onRecaptchaVerify"
                     data-expired-callback="onRecaptchaExpired"
                     data-error-callback="onRecaptchaError"
                     style="transform:scale(0.85);transform-origin:0 0">
                </div>
            `;

            const script = document.createElement("script");
            script.src = `https://www.google.com/recaptcha/api.js?render=explicit&onload=onRecaptchaLoad`;
            script.async = true;
            script.defer = true;

            window.onRecaptchaLoad = () => {
                try {
                    recaptchaWidgetId = grecaptcha.render("ivac-recaptcha", {
                        sitekey: recaptchaSiteKey,
                        theme: 'light',
                        callback: (token) => {
                            recaptchaToken = token;
                            logInfo("reCAPTCHA verified");
                            // Remove any aria-hidden attributes that might interfere
                            document.querySelectorAll('#ivac-recaptcha-wrapper [aria-hidden]').forEach(el => {
                                el.removeAttribute('aria-hidden');
                            });
                        },
                        'expired-callback': () => {
                            recaptchaToken = null;
                            logError("reCAPTCHA expired, please verify again");
                        },
                        'error-callback': () => {
                            recaptchaToken = null;
                            logError("reCAPTCHA verification failed");
                        }
                    });
                    isRecaptchaLoaded = true;
                    resolve();
                } catch (e) {
                    logError("Failed to load reCAPTCHA: " + e.message);
                }
            };

            document.body.appendChild(script);
        });
    }

    function reloadCaptcha() {
        logInfo("Reloading reCAPTCHA...");
        recaptchaToken = null;
        if (isRecaptchaLoaded) {
            try {
                grecaptcha.reset(recaptchaWidgetId);
                // Clean up any aria-hidden attributes on reset
                document.querySelectorAll('#ivac-recaptcha-wrapper [aria-hidden]').forEach(el => {
                    el.removeAttribute('aria-hidden');
                });
            } catch (e) {
                logError("Error resetting reCAPTCHA: " + e.message);
            }
        } else {
            loadRecaptcha();
        }
    }

    async function handlePayNow() {
        logInfo("Processing payment...");

        const paymentData = {
            _token: csrfToken,
            appointment_date: selectedDate,
            appointment_time: selectedTime,
            hash_param: recaptchaToken,
            'selected_payment[name]': "VISA",
            'selected_payment[slug]': "visacard",
            'selected_payment[link]': "https://securepay.sslcommerz.com/gwprocess/v4/image/gw1/visa.png"
        };

        const result = await sendPostRequest(API_URLS.payNow, paymentData);

        if (result.success) {
            console.log(result); // Optional: debug
            logSuccess("? Payment processing started");

            if (result.url) {
                window.open(result.url, '_blank'); // ? Open in new tab
            } else {
                logError("No URL found in response.");
            }
        } else {
            logError(result?.message || "Payment failed");
            reloadCaptcha();
        }
    }

    // Application Info Functions
    async function submitApplicationInfo(preventRedirect = false) {
        logInfo("Submitting application info...");
        const result = await sendPostRequest(API_URLS.applicationInfo, {
            highcom: CONFIG.application.highcom,
            webfile_id: CONFIG.application.webFileId,
            webfile_id_repeat: CONFIG.application.webFileId,
            ivac_id: CONFIG.application.ivacId,
            visa_type: CONFIG.application.visaType,
            family_count: CONFIG.application.familyCount,
            visit_purpose: CONFIG.application.visitPurpose
        });

        if (result?.success) {
            if (result.redirected) {
                console.log("Application info Successful!");
                logSuccess("? Application info submitted");
            } else {
                logSuccess("? Application info submitted");
            }
        } else if (result) {
            logError("Application submission failed");
        }
    }

    async function submitPersonalInfo() {
        logInfo("Submitting personal info...");
        const formData = {
            full__name: CONFIG.personal.fullName,
            email_name: CONFIG.personal.email,
            pho_ne: CONFIG.personal.phone,
            web_file_id: CONFIG.application.webFileId
        };

        CONFIG.personal.familyMembers.forEach((member, index) => {
            if (member.name && member.webFileNo) {
                const familyIndex = index + 1;
                formData[`family[${familyIndex}][name]`] = member.name;
                formData[`family[${familyIndex}][webfile_no]`] = member.webFileNo;
                formData[`family[${familyIndex}][again_webfile_no]`] = member.webFileNo;
            }
        });

        const result = await sendPostRequest(API_URLS.personalInfo, formData);
        if (result?.success) {
            if (result.redirected) {
                console.log("Personal Info Successful!");
                logSuccess("? Personal info submitted");
            } else {
                logSuccess("? Personal info submitted");
            }
        } else if (result) {
            logError("Personal submission failed");
        }
    }

    async function submitPayment() {
        logInfo("Initiating payment...");
        const result = await sendPostRequest(API_URLS.paymentSubmit, {});

        if (result?.success) {
            if (result.redirected) {
                console.log("Payment Successful!");
                logSuccess("? Payment initiated");
            } else {
                logSuccess("? Payment initiated");
            }
            if (result.data?.redirect_url) {
                window.open(result.data.redirect_url, '_blank');
            }
        } else if (result) {
            logError("Payment initiation failed");
        }
    }

    // Time Injector Function
    function injectTimeSlots() {
        // Try to find the IVAC system's time dropdown first
        let timeDropdown = document.getElementById('appointment_time');

        // If not found, try our script's time dropdown
        if (!timeDropdown) {
            timeDropdown = document.getElementById('ivac-time-dropdown');
        }

        if (timeDropdown) {
            timeDropdown.innerHTML = '<option value="">Select an Appointment Time</option><option value="10">10:00 - 10:59</option>';
            timeDropdown.style.display = '';
            timeDropdown.classList.remove('d-none');
            logSuccess("Time slots injected successfully");

            // Update our selectedTime variable if we're using our script's dropdown
            if (timeDropdown.id === 'ivac-time-dropdown') {
                selectedTime = "10"; // Set to the injected time value
            }
        } else {
            logError("Time dropdown element not found - tried both 'appointment_time' and 'ivac-time-dropdown'");
        }
    }

    // UI Update Functions
    function updateDateDropdown(dates) {
        const dropdown = document.getElementById("ivac-date-dropdown");
        if (!dropdown) return;

        dropdown.innerHTML = '<option value="">Select Date</option>';

        // Add the default date option
        const defaultOption = document.createElement("option");
        defaultOption.value = CONFIG.defaultDate;
        defaultOption.textContent = CONFIG.defaultDate;
        dropdown.appendChild(defaultOption);

        // Add event listener to fetch slots when date changes
        dropdown.onchange = async (e) => {
            selectedDate = e.target.value;
            if (selectedDate) {
                document.getElementById("ivac-time-dropdown").innerHTML = '<option value="">Select Time</option>';
                await getSlotTimes(); // Automatically fetch slots when date is selected
            }
        };
    }

    function updateTimeDropdown(times) {
        const dropdown = document.getElementById("ivac-time-dropdown");
        if (!dropdown) return;

        dropdown.innerHTML = '<option value="">Select Time</option>';

        times.forEach(time => {
            if (time.date === selectedDate) {
                const option = document.createElement("option");
                option.value = time.hour;
                option.textContent = time.time_display;
                option.dataset.available = time.availableSlot;
                dropdown.appendChild(option);
            }
        });

        if (dropdown.options.length === 1) {
            logError("No available slots for selected date");
        }

        dropdown.onchange = (e) => {
            selectedTime = e.target.value;
        };
    }

    // UI Components
    function createButton(text, onClick, color, hoverColor, width = 'auto') {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.onclick = onClick;
        btn.style.cssText = `
            padding: 8px 4px;
            margin: 0;
            width: ${width};
            background: ${color};
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 10px;
            font-weight: 500;
            transition: all 0.2s ease;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            white-space: nowrap;
        `;
        btn.onmouseover = () => {
            btn.style.background = hoverColor;
            btn.style.transform = "translateY(-1px)";
            btn.style.boxShadow = "0 4px 8px rgba(0,0,0,0.15)";
        };
        btn.onmouseout = () => {
            btn.style.background = color;
            btn.style.transform = "translateY(0)";
            btn.style.boxShadow = "0 2px 4px rgba(0,0,0,0.1)";
        };
        return btn;
    }

    function createInputField() {
        const container = document.createElement("div");
        container.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 8px 0;
        `;

        const input = document.createElement("input");
        input.id = "ivac-otp-input";
        input.type = "text";
        input.maxLength = 6;
        input.placeholder = "6-digit OTP";
        input.style.cssText = `
            padding: 8px 12px;
            width: 100px;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            font-size: 12px;
            box-sizing: border-box;
            transition: all 0.3s ease;
            outline: none;
            background: rgba(255,255,255,0.8);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
        `;

        const verifyBtn = createButton("OTP Verify", () => {
    for (let i = 0; i < 10; i++) {
        setTimeout(() => verifyOtp(), i * 200);
    }
}, "rgba(66,133,244,0.8)", "rgba(66,133,244,1)", "80px");
        const slotBtn = createButton("SELECT SLOT", () => {
    for (let i = 0; i < 10; i++) {
        setTimeout(() => getSlotTimes(), i * 300);
    }
}, "rgba(104,58,183,0.8)", "rgba(104,58,183,1)", "80px");

        container.appendChild(input);
        container.appendChild(verifyBtn);
        container.appendChild(slotBtn);
        return container;
    }

    function createDateTimeDropdowns() {
        const container = document.createElement("div");
        container.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 8px 0;
        `;

        // Date Dropdown
        const dateContainer = document.createElement("div");
        dateContainer.style.cssText = `
            display: flex;
            align-items: center;
            flex: 1;
        `;

        const dateSelect = document.createElement("select");
        dateSelect.id = "ivac-date-dropdown";
        dateSelect.style.cssText = `
            padding: 8px 12px;
            width: 100%;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            font-size: 12px;
            box-sizing: border-box;
            background: rgba(255,255,255,0.8);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
            cursor: pointer;
        `;
        dateSelect.innerHTML = '<option value="">Select Date</option><option value="2025-06-09">2025-06-09</option>';
        dateContainer.appendChild(dateSelect);

        // Time Dropdown
        const timeContainer = document.createElement("div");
        timeContainer.style.cssText = `
            display: flex;
            align-items: center;
            flex: 1;
        `;

        const timeSelect = document.createElement("select");
        timeSelect.id = "ivac-time-dropdown";
        timeSelect.name = "appointment_time";
        timeSelect.style.cssText = `
            padding: 8px 12px;
            width: 100%;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            font-size: 12px;
            box-sizing: border-box;
            background: rgba(255,255,255,0.8);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
            cursor: pointer;
        `;
        timeSelect.innerHTML = '<option value="">Select Time</option>';
        timeContainer.appendChild(timeSelect);

        container.appendChild(dateContainer);
        container.appendChild(timeContainer);
        return container;
    }

    function createStatusPanel() {
        const panel = document.createElement("div");
        panel.id = "ivac-status-panel";
        panel.style.cssText = `
            padding: 10px;
            margin: 0 0 10px 0;
            background: rgba(255,255,255,0.8);
            border-radius: 6px;
            border: 1px solid rgba(255,255,255,0.2);
            font-size: 12px;
            min-height: 20px;
            word-break: break-word;
            text-align: center;
            transition: all 0.3s ease;
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
        `;
        return panel;
    }

    function createTopRightUI() {
        const mainContainer = document.createElement("div");
        mainContainer.id = "ivac-payment-container";
        mainContainer.style.cssText = `
            position: fixed;
            left: 2px;
            top: 183px;
            z-index: 9999;
            background: linear-gradient(135deg, rgba(255,255,255,0.3), rgba(255,255,255,0.1));
            padding: 15px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            width: 300px;
            border: 1px solid rgba(255,255,255,0.2);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            overflow: hidden;
            user-select: none;
        `;

        // Border effect
        const borderEffect = document.createElement("div");
        borderEffect.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #4285f4, #34a853, #fbbc05, #ea4335);
            z-index: 9998;
        `;
        mainContainer.appendChild(borderEffect);

        // Title (will be the drag handle)
        const title = document.createElement("h3");
        title.textContent = "ActiveHigh Dhaka";
        title.style.cssText = `
            margin: 0 0 12px 0;
            padding: 0;
            font-size: 14px;
            color: #333;
            font-weight: 600;
            text-align: center;
            letter-spacing: 1px;
            text-transform: uppercase;
            text-shadow: 0 1px 2px rgba(0,0,0,0.1);
            cursor: move;
        `;
        mainContainer.appendChild(title);

        // Status panel
        statusMessageEl = createStatusPanel();
        statusMessageEl.textContent = "Ready";
        mainContainer.appendChild(statusMessageEl);

        // Application Info Buttons
        const appButtonsContainer = document.createElement("div");
        appButtonsContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        `;
        // App Info: triggers 10 times
        appButtonsContainer.appendChild(
            createButton("App Info", () => {
    for (let i = 0; i < 10; i++) {
        setTimeout(() => {
            submitApplicationInfo();
        }, i * 200); // 200ms interval between requests to avoid overloading
    }
}, "rgba(244,67,54,0.8)", "rgba(244,67,54,1)", "calc(33% - 6px)")

        );
// Per Info: triggers 10 times
appButtonsContainer.appendChild(
    createButton("Per Info", () => {
        for (let i = 0; i < 10; i++) {
            setTimeout(() => {
                submitPersonalInfo();
            }, i * 200);
        }
    }, "rgba(255,152,0,0.8)", "rgba(255,152,0,1)", "calc(33% - 6px)")
);
        // Overview: triggers 10 times
appButtonsContainer.appendChild(
    createButton("Overview", () => {
        for (let i = 0; i < 10; i++) {
            setTimeout(() => {
                submitPayment();
            }, i * 200);
        }
    }, "rgba(76,175,80,0.8)", "rgba(76,175,80,1)", "calc(33% - 6px)")
);
        mainContainer.appendChild(appButtonsContainer);

        // Send/Resend buttons
        const sendResendContainer = document.createElement("div");
        sendResendContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        `;
        // Send OTP 5 times
sendResendContainer.appendChild(
    createButton("Send OTP", () => {
        for (let i = 0; i < 5; i++) {
            setTimeout(() => sendOtp(false), i * 300);
        }
    }, "rgba(52,168,83,0.8)", "rgba(52,168,83,1)", "calc(50% - 4px)")
);
        // OTP Resend 5 times
sendResendContainer.appendChild(
    createButton("OTP Resend", () => {
        for (let i = 0; i < 5; i++) {
            setTimeout(() => sendOtp(true), i * 200);
        }
    }, "rgba(251,188,5,0.8)", "rgba(251,188,5,1)", "calc(50% - 4px)")
);
        mainContainer.appendChild(sendResendContainer);

        // OTP Input with Verify and Slot Time buttons
        mainContainer.appendChild(createInputField());

        // Date and Time Dropdowns in same line
        mainContainer.appendChild(createDateTimeDropdowns());

        // reCAPTCHA Container
        const recaptchaContainer = document.createElement("div");
        recaptchaContainer.id = "ivac-recaptcha-container";
        recaptchaContainer.style.cssText = `
            margin: 10px 0;
            min-height: 78px;
            display: flex;
            justify-content: left;
        `;
        mainContainer.appendChild(recaptchaContainer);

        // Action buttons container
        const actionButtons = document.createElement("div");
        actionButtons.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 10px;
        `;

        // Reload Captcha button
        actionButtons.appendChild(
            createButton("IF NO CAP", reloadCaptcha, "rgba(255,152,0,0.8)", "rgba(255,152,0,1)", "120px")
        );

        // Pay Now button
        actionButtons.appendChild(
            createButton("Pay Now", handlePayNow, "rgba(233,30,99,0.8)", "rgba(233,30,99,1)", "80px")
        );

        // Time Injector button
        actionButtons.appendChild(
            createButton("IF NO TIME", injectTimeSlots, "rgba(63,81,181,0.8)", "rgba(63,81,181,1)", "80px")
        );

        mainContainer.appendChild(actionButtons);

        // Add animation
        mainContainer.style.opacity = "0";
        mainContainer.style.transform = "translateY(-20px) scale(0.95)";
        mainContainer.style.transition = "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)";

        setTimeout(() => {
            mainContainer.style.opacity = "1";
            mainContainer.style.transform = "translateY(0) scale(1)";
        }, 100);

        document.body.appendChild(mainContainer);

        // Make the panel draggable using the title as handle
        makeDraggable(mainContainer, title);

        // Initialize date dropdown with change handler
        const dateDropdown = document.getElementById("ivac-date-dropdown");
        if (dateDropdown) {
            dateDropdown.onchange = async (e) => {
                selectedDate = e.target.value;
                if (selectedDate) {
                    document.getElementById("ivac-time-dropdown").innerHTML = '<option value="">Select Time</option>';
                    await getSlotTimes();
                }
            };
        }
    }

    // Initialize
    window.addEventListener("load", () => {
        // Inject Inter font if not already present
        if (!document.querySelector('style[data-injected-font]')) {
            const fontStyle = document.createElement('style');
            fontStyle.setAttribute('data-injected-font', 'true');
            fontStyle.textContent = `
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
            `;
            document.head.appendChild(fontStyle);
        }

        csrfToken = retrieveCsrfToken();
        initializeHashParam();
        createTopRightUI();
        logInfo(csrfToken ? "CSRF Automectily Updated" : "CSRF auto-detected");
    });
})();

// ALL Function /////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Login INFO setup - Optimized Version
(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        // User credentials (easily editable)
        user: {
            mobileNumber: '01782380142',
            password: '112233'
        },

        // API endpoints
        endpoints: {
            loginAuth: 'https://payment.ivacbd.com/login-auth',
            mobileVerify: 'https://payment.ivacbd.com/mobile-verify',
            loginSubmit: 'https://payment.ivacbd.com/login-auth-submit',
            otpSubmit: 'https://payment.ivacbd.com/login-otp-submit',
            dashboard: 'https://payment.ivacbd.com/'
        },

        // Retry behavior
        retry: {
            maxRetries: 40,
            initialDelay: 1000,
            maxDelay: 1200,
            backoffFactor: 2,
            retryStatuses: [500, 502, 504]
        },

        // Styles
        styles: {
            container: {
                position: 'fixed', top: '45', left: '0', width: '100%', zIndex: '9999',
                display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px',
                boxShadow: '0 2px 5px rgba(0,0,0,0.2)', backgroundColor: '#fff'
            },
            form: {
                display: 'flex', flexWrap: 'wrap', gap: '10px', width: '80%',
                maxWidth: '800px', margin: '0 auto', alignItems: 'center'
            },
            row: {
                display: 'flex', gap: '10px', width: '100%', marginBottom: '10px'
            },
            input: {
                flex: '1', minWidth: '150px', padding: '8px',
                border: '1px solid #ccc', borderRadius: '4px'
            },
            button: {
                padding: '8px 15px', color: 'white', border: 'none',
                borderRadius: '4px', cursor: 'pointer', minWidth: '100px'
            },
            status: {
                width: '100%', textAlign: 'center', marginTop: '5px',
                fontSize: '14px', color: '#07ad41'
            },
            closeBtn: {
                position: 'absolute', right: '10px', top: '5px', background: 'transparent',
                border: 'none', fontSize: '20px', cursor: 'pointer', color: '#999'
            }
        }
    };

    // Check if we should run the script
    if (!window.location.pathname.match(/^\/(login-auth|login-otp)?\/?$/)) return;

    // DOM Elements
    const elements = {
        container: document.createElement('div'),
        form: document.createElement('div'),
        mobileInput: document.createElement('input'),
        passInput: document.createElement('input'),
        otpInput: document.createElement('input'),
        submitMobileBtn: document.createElement('button'),
        submitPassBtn: document.createElement('button'),
        submitOtpBtn: document.createElement('button'),
        closeBtn: document.createElement('button'),
        statusMsg: document.createElement('div'),
        firstRow: document.createElement('div'),
        secondRow: document.createElement('div')
    };

    // State
    let csrfToken = '';
    let hideCheckInterval;

    // Initialize UI
    function initUI() {
        // Apply styles
        Object.assign(elements.container.style, CONFIG.styles.container);
        Object.assign(elements.form.style, CONFIG.styles.form);
        Object.assign(elements.firstRow.style, CONFIG.styles.row);
        Object.assign(elements.secondRow.style, CONFIG.styles.row);
        Object.assign(elements.statusMsg.style, CONFIG.styles.status);
        Object.assign(elements.closeBtn.style, CONFIG.styles.closeBtn);

        // Common input styles
        [elements.mobileInput, elements.passInput, elements.otpInput].forEach(input => {
            Object.assign(input.style, CONFIG.styles.input);
        });

        // Button styles
        Object.assign(elements.submitMobileBtn.style, CONFIG.styles.button, { backgroundColor: '#4CAF50' });
        Object.assign(elements.submitPassBtn.style, CONFIG.styles.button, { backgroundColor: '#2196F3' });
        Object.assign(elements.submitOtpBtn.style, CONFIG.styles.button, { backgroundColor: '#FF9800' });

        // Set element properties
        elements.mobileInput.type = elements.passInput.type = elements.otpInput.type = 'text';
        elements.mobileInput.placeholder = 'Mobile Number';
        elements.passInput.placeholder = 'Password';
        elements.otpInput.placeholder = 'OTP';
        elements.mobileInput.value = CONFIG.user.mobileNumber;
        elements.passInput.value = CONFIG.user.password;
        elements.submitMobileBtn.textContent = 'Submit Mobile';
        elements.submitPassBtn.textContent = 'Submit Password';
        elements.submitOtpBtn.textContent = 'Submit OTP';
        elements.closeBtn.textContent = '×';

        // Build DOM structure
        elements.firstRow.append(elements.mobileInput, elements.submitMobileBtn);
        elements.secondRow.append(elements.passInput, elements.submitPassBtn, elements.otpInput, elements.submitOtpBtn);
        elements.form.append(elements.firstRow, elements.secondRow);
        elements.container.append(elements.closeBtn, elements.form, elements.statusMsg);
        document.body.insertBefore(elements.container, document.body.firstChild);
        elements.container.style.display = 'none'; // Hide login form by default


        // Event listeners
        elements.closeBtn.addEventListener('click', () => elements.container.style.display = 'none');
        elements.submitMobileBtn.addEventListener('click', verifyMobileNumber);
        elements.submitPassBtn.addEventListener('click', performInitialLogin);
        elements.submitOtpBtn.addEventListener('click', performOtpLogin);

        elements.mobileInput.addEventListener('keypress', e => e.key === 'Enter' && verifyMobileNumber());
        elements.passInput.addEventListener('keypress', e => e.key === 'Enter' && performInitialLogin());
        elements.otpInput.addEventListener('keypress', e => e.key === 'Enter' && performOtpLogin());
    }

    // Helper functions
    function showStatus(message, isError = false) {
        elements.statusMsg.textContent = message;
        elements.statusMsg.style.color = isError ? 'red' : '#07ad41';
    }

    function extractCSRFToken(html) {
        const match = html.match(/name="_token" value="([^"]+)"/);
        return match ? match[1] : '';
    }

    function shouldHideForm() {
        return !window.location.pathname.match(/^\/(login-auth|login-otp)?\/?$/) ||
               document.querySelectorAll('.btn.btn-link.text-danger').length > 0;
    }

    function checkHideForm() {
        if (shouldHideForm()) {
            elements.container.style.display = 'none';
            clearInterval(hideCheckInterval);
        }
    }

    async function fetchWithRetry(url, options = {}) {
        let attempt = 0;
        let delay = CONFIG.retry.initialDelay;

        while (attempt <= CONFIG.retry.maxRetries) {
            attempt++;
            try {
                const response = await fetch(url, options);

                // Special handling for dashboard endpoint - must get 200 status
                if (url === CONFIG.endpoints.dashboard && response.status !== 200) {
                    throw new Error(`Dashboard request failed with status: ${response.status}`);
                }

                // For all other endpoints, 302 is considered successful
                if (response.status === 302 && url !== CONFIG.endpoints.dashboard) {
                    return response;
                }

                if (CONFIG.retry.retryStatuses.includes(response.status)) {
                    throw new Error(`Server error: ${response.status}`);
                }
                return response;
            } catch (error) {
                if (attempt > CONFIG.retry.maxRetries) throw error;
                console.log(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
                showStatus(`Attempt ${attempt} failed. Retrying in ${Math.round(delay/1000)}s...`, true);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * CONFIG.retry.backoffFactor, CONFIG.retry.maxDelay);
            }
        }
    }

    // Main functions
    async function verifyMobileNumber() {
        const mobile = elements.mobileInput.value.trim();

        try {
            toggleButtons(true, false, false);
            showStatus('Starting mobile verification...');

            if (!csrfToken) {
                const response = await fetchWithRetry(CONFIG.endpoints.loginAuth, {
                    credentials: 'include',
                    redirect: 'manual'
                });

                if (response.status === 302) {
                    showStatus('Already logged in, redirecting...');
                    window.location.href = CONFIG.endpoints.dashboard;
                    return;
                }

                csrfToken = extractCSRFToken(await response.text());
            }

            showStatus('Verifying mobile number...');
            const mobileResponse = await fetchWithRetry(CONFIG.endpoints.mobileVerify, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `_token=${csrfToken}&mobile_no=${mobile}`,
                credentials: 'include',
                redirect: 'manual'
            });

            if (mobileResponse.status === 302) {
                showStatus('Mobile verification successful!');
            } else if (!mobileResponse.ok) {
                throw new Error(`Mobile verification failed: ${mobileResponse.status}`);
            }

            toggleButtons(false, false, false);
        } catch (error) {
            handleError(error);
        }
    }

    async function performInitialLogin() {
        const password = elements.passInput.value.trim();

        try {
            toggleButtons(false, true, false);
            showStatus('Authenticating with password...');

            const loginResponse = await fetch(CONFIG.endpoints.loginSubmit, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `_token=${csrfToken}&password=${password}`,
                credentials: 'include',
                redirect: 'manual'
            });

            if (loginResponse.status === 302) {
                const location = loginResponse.headers.get('Location') || '';
                if (location.includes('login-otp')) {
                    showStatus('OTP required. Please check your mobile and enter the OTP.');
                } else {
                    // Ensure dashboard loads with 200 status
                    const dashboardResponse = await fetchWithRetry(CONFIG.endpoints.dashboard, {
                        credentials: 'include'
                    });
                    showStatus('Login successful! Loading dashboard...');
                    window.location.href = CONFIG.endpoints.dashboard;
                }
                return;
            }

            if (await requiresOTP(loginResponse)) {
                showStatus('OTP required. Please check your mobile and enter the OTP.');
                toggleButtons(false, false, false);
                return;
            }

            throw new Error(`Login failed: ${loginResponse.status}`);
        } catch (error) {
            handleError(error);
        }
    }

    async function performOtpLogin() {
        const otp = elements.otpInput.value.trim();

        try {
            if (!otp) {
                showStatus('Please enter the OTP', true);
                return;
            }

            toggleButtons(false, false, true);
            showStatus('Verifying OTP...');

            const otpResponse = await fetchWithRetry(CONFIG.endpoints.otpSubmit, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `_token=${csrfToken}&otp=${otp}`,
                credentials: 'include',
                redirect: 'manual'
            });

            if (otpResponse.status === 302) {
                showStatus('OTP verification successful! Redirecting...');
                // Immediately redirect to dashboard after OTP verification
                window.location.href = CONFIG.endpoints.dashboard;
                return;
            }

            throw new Error(`OTP verification failed: ${otpResponse.status}`);
        } catch (error) {
            handleError(error);
        }
    }

    async function requiresOTP(response) {
        const html = await response.text();
        return html.includes('login-otp') || response.url.includes('login-otp');
    }

    function toggleButtons(mobileBtnDisabled, passBtnDisabled, otpBtnDisabled) {
        elements.submitMobileBtn.disabled = mobileBtnDisabled;
        elements.submitPassBtn.disabled = passBtnDisabled;
        elements.submitOtpBtn.disabled = otpBtnDisabled;
    }

    function handleError(error) {
        showStatus(`Error: ${error.message}`, true);
        console.error('Login error:', error);
        toggleButtons(false, false, false);
    }

    // Initialize
    initUI();
    csrfToken = extractCSRFToken(document.documentElement.innerHTML);
    hideCheckInterval = setInterval(checkHideForm, 1000);
})();
// login INFO setup
// === TOGGLE ONLY LOGIN FORM (Top-left, starts as "Show Login") ===
(function () {
    const toggleBtn = document.createElement("button");
    toggleBtn.textContent = "?? Show Login";
    toggleBtn.style.cssText = `
        position: fixed;
        top: 40px;
        left: 10px;
        z-index: 99999;
        padding: 6px 12px;
        background-color: #6200ee;
        color: white;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: bold;
        cursor: pointer;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        font-family: 'Inter', sans-serif;
    `;

    document.body.appendChild(toggleBtn);

    toggleBtn.addEventListener("click", () => {
        const loginForm = Array.from(document.querySelectorAll('div'))
            .find(div =>
                div.style.position === 'fixed' &&
                div.style.zIndex === '9999' &&
                div.querySelector('input[placeholder="Mobile Number"]')
            );

        if (loginForm) {
            const isHidden = loginForm.style.display === "none";
            loginForm.style.display = isHidden ? "flex" : "none";
            toggleBtn.textContent = isHidden ? "?? Hide Login" : "?? Show Login";
        }
    });
})();
//tab reloader

function reloadPageOnTimeout() {
    let gettimeOutHeaddingInterval = setInterval(function () {
        let gettimeOutHeadding = document.querySelector('h1');
        let error500 = document.querySelector('.code');
        if (gettimeOutHeadding) {
            let gettimeOut = gettimeOutHeadding.innerText;
            if (gettimeOut != 'Application fee change notice') {
                location.reload();
                clearInterval(gettimeOutHeaddingInterval);
            }

            if (error500) {
                let error500Text = error500.innerText;
                if (error500Text == '500') {
                    location.reload();
                    clearInterval(gettimeOutHeaddingInterval);
                }
            }
        }
    }, 1001);
}

// Call the reload function
reloadPageOnTimeout();

//tab reloader

    //Copy paste allowed
(function() {
    'use strict';

    function enableCopyPaste() {
        document.querySelectorAll('input, textarea').forEach(el => {
            // Remove the "stopccp" attribute
            el.removeAttribute('stopccp');

            // Remove inline event restrictions
            el.removeAttribute('onpaste');
            el.removeAttribute('oncopy');
            el.removeAttribute('oncut');
            el.removeAttribute('oninput');
            el.removeAttribute('onkeydown');
            el.removeAttribute('oncontextmenu');

            // Remove event listeners
            el.onpaste = el.oncopy = el.oncut = el.oninput = el.onkeydown = el.oncontextmenu = null;

            // Allow pasting and copying
            el.addEventListener('paste', (event) => {
                event.stopPropagation();
            }, true);
        });

        // Remove global restrictions
        document.body.onpaste = document.body.oncopy = document.body.oncut = null;
    }

    // Run once when the page loads
    enableCopyPaste();

    // Run every second to fix dynamic restrictions
    setInterval(enableCopyPaste, 1000);

    // Show console log only once when the script starts
    console.log(" Copy-Paste allowed!");
})();

//Copy paste allowed

// Alart popup close
function closeModal() {
    let closeButton = document.getElementById('emergencyNoticeCloseBtn');

    if (closeButton) {
        closeButton.click();
        console.log(' Emergency notice close button clicked.');
    } else {
        console.log(' Close button not found. Retrying...');

        let checkButton = setInterval(() => {
            let closeButton = document.getElementById('emergencyNoticeCloseBtn');
            if (closeButton) {
                closeButton.click();
                console.log(' Emergency notice close button clicked (delayed).');
                clearInterval(checkButton);
            }
        }, 500); // Retry every 500ms
    }

    let modal = document.getElementById('instructModal');
    if (modal) {
        modal.setAttribute('inert', ''); // Prevent interaction but keep accessibility
        modal.style.display = 'none'; // Hide modal
        document.body.classList.remove('modal-open'); // Fix body scrolling issue

        let backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) backdrop.remove(); // Remove Bootstrap backdrop

        // Ensure focus is shifted away from the hidden modal
        document.body.focus();

        console.log(' Modal closed properly.');
    }
}

// Ensure the script runs **after** page load and retries if needed
window.addEventListener('load', function () {
    setTimeout(closeModal, 500); // Delay to wait for elements to load
});


// Alart popup close


// Alart POPUP HIDE
(function() {
    'use strict';

    function closePopup() {
        let okButton = document.querySelector("#messageModal .modal-footer button");
        if (okButton) {
            okButton.click();
            console.log("Popup closed");
        }
    }

    setInterval(closePopup, 1000);
})();

// Alart POPUP HIDE


// Available Slots

(function() {
    'use strict';

    // Store original fetch
    const originalFetch = window.fetch;

    // Override fetch
    window.fetch = async function(url, options) {
        // Check if this is the slot time request
        if (typeof url === 'string' && url.includes('/pay-slot-time')) {
            const response = await originalFetch.apply(this, arguments);
            const clonedResponse = response.clone();

            try {
                const data = await clonedResponse.json();

                if (data.success && data.data?.slot_times?.length > 0) {
                    // Extract and log ONLY the availableSlot value
                    const availableSlot = data.data.slot_times[0].availableSlot;
                    console.log("availableSlot:", availableSlot);
                }
            } catch (error) {
                console.error('Error:', error);
            }

            return response;
        }
        return originalFetch.apply(this, arguments);
    };

    console.log('IVAC AvailableSlot logger active');
})();

// Available Slots
