-- Check for table that is shared between executions.
if not shared then
	return warn("No shared, no script.")
end

-- Config. Copy this block from the dashboard (Scripts > Loader).
local CONFIG = {
	apiUrl = "http://127.0.0.1:3000/api/v1/auth",
	scriptId = "REPLACE_SCRIPT_ID",
	secret = "REPLACE_SCRIPT_SECRET",
}

-- Constants.
local MAX_CLOCK_SKEW = 600
local REQUEST_TIMEOUT_RETRIES = 2

-- Services.
local httpService = game:GetService("HttpService")
local playersService = game:GetService("Players")

-- State.
local localPlayer = playersService.LocalPlayer

---Report a failure to the user.
---@param message string
local function fail(message)
	warn("[NYXARIS] " .. tostring(message))
end

---Create a one-time nonce so the signed response can't be replayed.
---@return string
local function createNonce()
	return (httpService:GenerateGUID(false):gsub("-", ""))
end

---Fetch the key supplied by the user (set `script_key = "NYX-..."` before loading).
---@return string?
local function getKey()
	local env = getgenv()
	return env.script_key or env.scriptKey
end

---Send the auth request with a small retry for transient network errors.
---@param body table
---@return table?, string?
local function sendAuth(body)
	local encoded = httpService:JSONEncode(body)
	local lastError = "no response"

	for _ = 1, REQUEST_TIMEOUT_RETRIES + 1 do
		local ok, response = pcall(request, {
			Url = CONFIG.apiUrl,
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json" },
			Body = encoded,
		})

		-- 4xx replies still carry a signed JSON body, so don't gate on Success.
		if ok and response and response.Body and response.Body ~= "" then
			local decoded, data = pcall(httpService.JSONDecode, httpService, response.Body)
			if decoded and type(data) == "table" then
				return data
			end
			lastError = "bad response (" .. tostring(response.StatusCode) .. ")"
		else
			lastError = tostring(response)
		end

		task.wait(1)
	end

	return nil, lastError
end

---Check the server signature binds this nonce, result and payload together.
---@param data table
---@param nonce string
---@return boolean
local function verifyResponse(data, nonce)
	if data.nonce ~= nonce or type(data.sig) ~= "string" or type(data.ts) ~= "number" then
		return false
	end

	if math.abs(os.time() - data.ts) > MAX_CLOCK_SKEW then
		return false
	end

	local ok = data.ok == true
	local payloadHash = ""

	if ok then
		if type(data.payload) ~= "string" then
			return false
		end
		payloadHash = crypt.hash(data.payload, "sha256")
	end

	local message = string.format("%s|%d|%s|%d|%s", nonce, ok and 1 or 0, tostring(data.code), data.ts, payloadHash)
	local expected = crypt.hmac(CONFIG.secret, message, "sha256")

	return string.lower(expected) == string.lower(data.sig)
end

---Authenticate and run the protected script.
local function initializeLoader()
	local key = getKey()
	if type(key) ~= "string" or key == "" then
		return fail('No key. Set script_key = "NYX-..." before running the loader.')
	end

	local nonce = createNonce()
	local data, err = sendAuth({
		key = key,
		hwid = gethwid(),
		script = CONFIG.scriptId,
		nonce = nonce,
		userId = localPlayer and localPlayer.UserId or nil,
		placeId = game.PlaceId,
	})

	if not data then
		return fail("Could not reach auth server: " .. tostring(err))
	end

	-- Never trust an unsigned or mismatching reply (stops local fake servers).
	if not verifyResponse(data, nonce) then
		return fail("Invalid server signature.")
	end

	if not data.ok then
		return fail(data.message or data.code)
	end

	local chunk, compileError = loadstring(data.payload, "=NyxarisScript")
	if not chunk then
		return fail("Script failed to compile: " .. tostring(compileError))
	end

	shared.Nyxaris = { version = data.version, expiresAt = data.expiresAt }
	chunk()
end

---This is called when the loader errors.
---@param error string
local function onInitializeError(error)
	fail("Loader error.")
	warn(error)
	warn(debug.traceback())
end

-- Safely initialize and handle errors.
xpcall(initializeLoader, onInitializeError)
