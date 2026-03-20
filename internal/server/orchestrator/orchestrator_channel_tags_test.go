package orchestrator

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestParseChannelTags(t *testing.T) {
	tests := []struct {
		name     string
		header   string
		expected []string
	}{
		{
			name:     "empty string",
			header:   "",
			expected: nil,
		},
		{
			name:     "single tag",
			header:   "fast",
			expected: []string{"fast"},
		},
		{
			name:     "multiple tags",
			header:   "fast,premium,gpu",
			expected: []string{"fast", "premium", "gpu"},
		},
		{
			name:     "tags with whitespace",
			header:   " fast , premium , gpu ",
			expected: []string{"fast", "premium", "gpu"},
		},
		{
			name:     "trailing comma",
			header:   "fast,premium,",
			expected: []string{"fast", "premium"},
		},
		{
			name:     "leading comma",
			header:   ",fast,premium",
			expected: []string{"fast", "premium"},
		},
		{
			name:     "only commas",
			header:   ",,,",
			expected: nil,
		},
		{
			name:     "only whitespace",
			header:   "  ,  ,  ",
			expected: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := parseChannelTags(tt.header)
			assert.Equal(t, tt.expected, result)
		})
	}
}
