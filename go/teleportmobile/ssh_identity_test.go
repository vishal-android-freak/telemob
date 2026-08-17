package teleportmobile

import (
	"crypto/ed25519"
	"crypto/rand"
	"net/url"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestNewSSHKeyPair(t *testing.T) {
	for _, test := range []struct {
		name string
		fips bool
		want string
	}{
		{name: "standard", want: ssh.KeyAlgoECDSA256},
		{name: "fips", fips: true, want: ssh.KeyAlgoRSA},
	} {
		t.Run(test.name, func(t *testing.T) {
			privateKey, publicKey, err := newSSHKeyPair(test.fips)
			if err != nil {
				t.Fatalf("generate key: %v", err)
			}
			if _, err := ssh.ParsePrivateKey(privateKey); err != nil {
				t.Fatalf("parse private key: %v", err)
			}
			parsed, _, _, _, err := ssh.ParseAuthorizedKey(publicKey)
			if err != nil {
				t.Fatalf("parse public key: %v", err)
			}
			if parsed.Type() != test.want {
				t.Fatalf("got key type %q, want %q", parsed.Type(), test.want)
			}
		})
	}
}

func TestTeleportHostKeyCallbackScopesPrincipals(t *testing.T) {
	_, caPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caSigner, err := ssh.NewSignerFromKey(caPrivate)
	if err != nil {
		t.Fatal(err)
	}
	hostPublic, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	hostKey, err := ssh.NewPublicKey(hostPublic)
	if err != nil {
		t.Fatal(err)
	}
	now := uint64(time.Now().Unix())
	certificate := &ssh.Certificate{
		Key:             hostKey,
		CertType:        ssh.HostCert,
		ValidPrincipals: []string{"proxy.example.com"},
		ValidAfter:      now - 1,
		ValidBefore:     now + 60,
	}
	if err := certificate.SignCert(rand.Reader, caSigner); err != nil {
		t.Fatal(err)
	}
	encodedCA := ssh.MarshalAuthorizedKey(caSigner.PublicKey())
	proxyCallback, err := teleportHostKeyCallback([][]byte{encodedCA}, "proxy.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if err := proxyCallback("", nil, certificate); err != nil {
		t.Fatalf("proxy principal rejected: %v", err)
	}
	nodeCallback, err := teleportHostKeyCallback([][]byte{encodedCA}, "node.example.com", "node-id")
	if err != nil {
		t.Fatal(err)
	}
	if err := nodeCallback("", nil, certificate); err == nil {
		t.Fatal("expected proxy-only certificate to be rejected for a node")
	}
}

func TestResolveSSHProxyAddress(t *testing.T) {
	baseURL, err := url.Parse("https://proxy.example.com")
	if err != nil {
		t.Fatal(err)
	}
	var tlsPing proxyPing
	tlsPing.Proxy.TLSRoutingEnabled = true
	if got := resolveSSHProxyAddress(baseURL, tlsPing); got != "proxy.example.com:443" {
		t.Fatalf("TLS routing address = %q", got)
	}

	var separatePing proxyPing
	separatePing.Proxy.SSH.SSHPublicAddr = "ssh.example.com:3024"
	if got := resolveSSHProxyAddress(baseURL, separatePing); got != "ssh.example.com:3024" {
		t.Fatalf("separate SSH address = %q", got)
	}

	var fallbackPing proxyPing
	fallbackPing.Proxy.SSH.PublicAddr = "proxy.example.com:443"
	fallbackPing.Proxy.SSH.ListenAddr = "0.0.0.0:3023"
	if got := resolveSSHProxyAddress(baseURL, fallbackPing); got != "proxy.example.com:3023" {
		t.Fatalf("fallback SSH address = %q", got)
	}
}
