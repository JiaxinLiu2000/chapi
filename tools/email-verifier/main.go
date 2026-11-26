// chapi-email-verifier: one-shot batch wrapper around github.com/AfterShip/email-verifier.
//
// Reads a JSON request on stdin, verifies every address (syntax → MX → SMTP with
// catch-all probe → disposable/role/free → domain typo suggestion) with bounded
// concurrency, and writes one JSON item per address to stdout, in input order.
// Built and invoked by apps/server/src/tools/emailVerify.ts.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	emailverifier "github.com/AfterShip/email-verifier"
)

type request struct {
	Emails             []string `json:"emails"`
	Proxy              string   `json:"proxy"` // socks5://user:pass@host:port, "" = direct
	FromEmail          string   `json:"fromEmail"`
	HelloName          string   `json:"helloName"`
	Concurrency        int      `json:"concurrency"`
	ConnectTimeoutMs   int      `json:"connectTimeoutMs"`
	OperationTimeoutMs int      `json:"operationTimeoutMs"`
}

type item struct {
	Email  string                `json:"email"`
	Result *emailverifier.Result `json:"result"`
	// Error is the full error text; ErrorKind is LookupError.Message (one of the
	// library's Err* constants, e.g. "Mail server does not exist") when available.
	Error     *string `json:"error"`
	ErrorKind *string `json:"errorKind"`
}

func main() {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		fmt.Fprintln(os.Stderr, "invalid request:", err)
		os.Exit(2)
	}
	if req.Concurrency < 1 {
		req.Concurrency = 1
	}

	v := emailverifier.NewVerifier().
		EnableSMTPCheck().
		EnableDomainSuggest()
	if req.Proxy != "" {
		v.Proxy(req.Proxy)
	}
	if req.FromEmail != "" {
		v.FromEmail(req.FromEmail)
	}
	if req.HelloName != "" {
		v.HelloName(req.HelloName)
	}
	if req.ConnectTimeoutMs > 0 {
		v.ConnectTimeout(time.Duration(req.ConnectTimeoutMs) * time.Millisecond)
	}
	if req.OperationTimeoutMs > 0 {
		v.OperationTimeout(time.Duration(req.OperationTimeoutMs) * time.Millisecond)
	}

	out := make([]item, len(req.Emails))
	sem := make(chan struct{}, req.Concurrency)
	var wg sync.WaitGroup
	for i, email := range req.Emails {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, email string) {
			defer wg.Done()
			defer func() { <-sem }()
			// Verify returns a partial result alongside its error (e.g. an SMTP
			// timeout after MX succeeded), so keep both.
			res, err := v.Verify(email)
			it := item{Email: email, Result: res}
			if err != nil {
				msg := err.Error()
				it.Error = &msg
				var le *emailverifier.LookupError
				if errors.As(err, &le) {
					kind := le.Message
					it.ErrorKind = &kind
				}
			}
			out[i] = it
		}(i, email)
	}
	wg.Wait()

	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
}
